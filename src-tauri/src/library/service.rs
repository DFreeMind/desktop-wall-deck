//! 壁纸库服务：导入、列出、删除。
//!
//! 设计要点：
//!
//! 1. **本机文件只索引**。缩略图与投放缓存归应用管理，不改写用户原图。
//!    下载图片与旧版副本保留为 managed，兼容已有数据。
//! 2. **按源路径去重**。重复导入同一文件只跳过，不产生副本，避免磁盘膨胀。
//! 3. **批量导入逐条容错**。一张坏图不应让整批失败，失败原因逐条返回给 UI。

use std::path::{Path, PathBuf};

use super::db::{chrono_now, Db, WallpaperRecord};
use super::error::{LibError, LibResult};
use super::image_ops;
use super::model::{CacheCleanupReport, Folder, FolderNode, FolderScan, ImportFailure, ImportReport, Wallpaper, WallpaperDetails};

pub struct Library {
    root: PathBuf,
    db: Db,
    import_lock: parking_lot::Mutex<()>,
    render_lock: parking_lot::Mutex<()>,
    repair_lock: parking_lot::Mutex<()>,
}

impl Library {
    /// `root` 为应用数据目录，库文件与缩略图都在其下。
    pub fn open(root: PathBuf) -> LibResult<Self> {
        std::fs::create_dir_all(&root)
            .map_err(|e| LibError::Io(format!("创建库目录失败：{e}")))?;
        let db = Db::open(&root.join("library.db"))?;
        Ok(Self { root, db, import_lock: parking_lot::Mutex::new(()), render_lock: parking_lot::Mutex::new(()), repair_lock: parking_lot::Mutex::new(()) })
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn storage(&self) -> LibResult<super::model::LibraryStorage> {
        let list = self.db.list()?;
        let mut result = super::model::LibraryStorage { count: list.len(), ..Default::default() };
        for record in list {
            if record.storage_kind == "indexed" { result.indexed_bytes += record.bytes; }
            else { result.managed_bytes += Path::new(&record.file_path).metadata().map(|m| m.len()).unwrap_or(0); }
        }
        // 包含为了旧版当前桌面而保留的文件，不把它们漏算成“零占用”。
        result.managed_bytes = directory_size_safe(&self.root.join("files"));
        result.thumbnail_bytes = directory_size_safe(&self.root.join("thumbs"));
        result.rendered_bytes = directory_size_safe(&self.root.join("rendered")) + directory_size_safe(&self.root.join("span")) + directory_size_safe(&self.root.join("previews"));
        Ok(result)
    }

    pub fn rescan_source(&self, id: &str) -> LibResult<ImportReport> {
        let source = self.db.source_folders()?.into_iter().find(|s| s.id == id)
            .ok_or_else(|| LibError::NotFound("来源文件夹不存在".into()))?;
        self.import_folder(Path::new(&source.path), source.folder_id.as_deref())
    }

    pub fn refresh_sources(&self) -> LibResult<ImportReport> {
        let mut report = ImportReport::default();
        for source in self.db.source_folders()?.into_iter().filter(|s| s.available) {
            match self.rescan_source(&source.id) {
                Ok(result) => { report.added += result.added; report.updated += result.updated; report.failed.extend(result.failed); }
                Err(e) => report.failed.push(super::model::ImportFailure { path: source.path, reason: e.to_string() }),
            }
        }
        // 单独添加的文件同样检测变化，缺失项保留而不是静默删除。
        let _guard = self.import_lock.lock();
        for record in self.db.list()?.into_iter().filter(|r| r.storage_kind == "indexed") {
            if Path::new(&record.file_path).is_file() {
                match self.import_one(Path::new(&record.file_path), record.folder_id.as_deref()) {
                    Ok((2, _)) => report.updated += 1,
                    Ok(_) => {},
                    Err(e) => report.failed.push(super::model::ImportFailure { path: record.file_path, reason: e.to_string() }),
                }
            }
        }
        Ok(report)
    }

    /// 重定位按相对路径保留 ID 与合集。先校验全部目标，再在事务内更新，避免部分迁移。
    pub fn relocate_source(&self, id: &str, path: &Path) -> LibResult<ImportReport> {
        let _guard = self.import_lock.lock();
        let source = self.db.source_folders()?.into_iter().find(|s| s.id == id)
            .ok_or_else(|| LibError::NotFound("来源文件夹不存在".into()))?;
        let canonical = canonical_source(path)?;
        if !canonical.is_dir() { return Err(LibError::Io("请选择文件夹".into())); }
        if self.db.source_folders()?.iter().any(|s| s.id != id && Path::new(&s.path) == canonical) {
            return Err(LibError::Io("这个文件夹已经作为来源添加".into()));
        }
        let all = self.db.list()?;
        let mut changes = Vec::new();
        for mut record in all.iter().filter(|r| r.storage_kind == "indexed").cloned() {
            let Ok(relative) = Path::new(&record.file_path).strip_prefix(&source.path) else { continue; };
            let target = canonical.join(relative);
            if all.iter().any(|r| r.id != record.id && Path::new(&r.file_path) == target) {
                return Err(LibError::Io("目标目录存在已索引图片，未修改来源；请先处理重复记录".into()));
            }
            record.file_path = target.to_string_lossy().to_string();
            record.source_path = record.file_path.clone();
            if target.is_file() {
                let (width, height) = image_ops::oriented_dimensions(&target)?;
                record.width = width; record.height = height;
                record.bytes = target.metadata()?.len(); record.source_stamp = source_stamp(&target)?;
            } else { record.source_stamp.clear(); }
            changes.push(record);
        }
        self.db.relocate_indexed(id, &canonical.to_string_lossy(), &changes)?;
        for record in &changes { let _ = std::fs::remove_file(&record.thumb_path); }
        drop(_guard);
        let mut report = self.rescan_source(id)?;
        report.updated += changes.len();
        Ok(report)
    }

    pub fn relink_wallpaper(&self, id: &str, path: &Path) -> LibResult<()> {
        let _guard = self.import_lock.lock();
        let mut record = self.db.get(id)?.ok_or_else(|| LibError::NotFound("壁纸不存在".into()))?;
        if record.storage_kind != "indexed" { return Err(LibError::Io("仅本机索引图片需要重新定位".into())); }
        let path = canonical_source(path)?;
        if self.db.list()?.iter().any(|r| r.id != id && Path::new(&r.file_path) == path) {
            return Err(LibError::Io("这张图片已在壁纸库中".into()));
        }
        let (width, height) = image_ops::oriented_dimensions(&path)?;
        record.width = width; record.height = height; record.bytes = path.metadata()?.len();
        record.source_stamp = source_stamp(&path)?;
        record.file_path = path.to_string_lossy().to_string(); record.source_path = record.file_path.clone();
        self.db.update_index(&record)?;
        let _ = std::fs::remove_file(record.thumb_path);
        Ok(())
    }

    /// 列出全部壁纸，按导入时间倒序。
    pub fn list(&self) -> LibResult<Vec<Wallpaper>> {
        Ok(self.db.list()?.into_iter().map(Wallpaper::from).collect())
    }

    /// 取单张壁纸的库内绝对路径。投放壁纸时用它。
    pub fn file_path_of(&self, id: &str) -> LibResult<Option<String>> {
        Ok(self.db.get(id)?.map(|r| r.file_path))
    }

    /// 按库内 ID 返回原图详情，不接受调用方提供的文件路径。
    pub fn wallpaper_details(&self, id: &str) -> LibResult<WallpaperDetails> {
        let record = self.db.get(id)?.ok_or_else(|| LibError::NotFound("壁纸记录不存在".into()))?;
        let path = Path::new(&record.file_path);
        let metadata = match path.metadata() {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(LibError::Io(format!("读取图片文件信息失败：{error}"))),
        };
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let parent_path = path.parent().unwrap_or_else(|| Path::new("")).to_string_lossy().into_owned();
        let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        let unix_seconds = |time: std::io::Result<std::time::SystemTime>| {
            time.ok().and_then(|time| match time.duration_since(std::time::UNIX_EPOCH) {
                Ok(duration) => i64::try_from(duration.as_secs()).ok(),
                Err(error) => i64::try_from(error.duration().as_secs()).ok().map(|seconds| -seconds),
            })
        };
        Ok(WallpaperDetails {
            id: record.id,
            name: record.name,
            file_name,
            file_path: record.file_path,
            parent_path,
            extension,
            width: record.width,
            height: record.height,
            bytes: metadata.as_ref().map(std::fs::Metadata::len).unwrap_or(record.bytes),
            indexed_at: record.created_at,
            file_created_at: metadata.as_ref().and_then(|m| unix_seconds(m.created())),
            file_modified_at: metadata.as_ref().and_then(|m| unix_seconds(m.modified())),
            exists: metadata.is_some(),
            storage_kind: record.storage_kind,
        })
    }

    /// 解析资源管理器定位目标；文件离线时返回仍存在的父目录。
    pub fn wallpaper_reveal_target(&self, id: &str) -> LibResult<PathBuf> {
        let record = self.db.get(id)?.ok_or_else(|| LibError::NotFound("壁纸记录不存在".into()))?;
        let path = PathBuf::from(record.file_path);
        match path.metadata() {
            Ok(_) => Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = path.parent().filter(|parent| parent.is_dir());
                parent.map(Path::to_path_buf).ok_or_else(|| LibError::Io("原图片和所在文件夹都不存在，无法在资源管理器中定位".into()))
            }
            Err(error) => Err(LibError::Io(format!("读取图片文件信息失败：{error}"))),
        }
    }

    /// 批量导入文件或目录（目录会递归扫描）。
    ///
    /// `folder_id` 指定入库后归属的文件夹；`None` 表示放在库根目录。
    /// 导入到某个文件夹时，其子文件夹也会被递归扫描，但所有图片都归到该文件夹下，
    /// 不做「按源目录自动建子目录」——那会让用户的目录结构被意外复制进库。
    pub fn import(&self, paths: &[PathBuf], folder_id: Option<&str>) -> LibResult<ImportReport> {
        let _guard = self.import_lock.lock();
        let mut report = ImportReport::default();

        // 目标文件夹必须存在，否则会写入悬挂引用
        if let Some(fid) = folder_id {
            if self.db.get_folder(fid)?.is_none() {
                return Err(LibError::Io("目标文件夹不存在".into()));
            }
        }

        for path in self.expand(paths) {
            let canonical = match canonical_source(&path) {
                Ok(path) => path,
                Err(error) => { report.failed.push(ImportFailure { path: path.display().to_string(), reason: error.to_string() }); continue; }
            };
            let key = canonical.to_string_lossy();
            if paths.iter().any(|p| p.is_file() && canonical_source(p).ok().as_ref() == Some(&canonical)) {
                self.db.unexclude(&key)?;
            } else if self.db.excluded(&key)? { report.skipped += 1; continue; }
            match self.import_one(&path, folder_id) {
                Ok((1, _)) => report.added += 1,
                Ok((2, _)) => report.updated += 1,
                Ok(_) => report.skipped += 1,
                Err(e) => report.failed.push(ImportFailure {
                    path: path.display().to_string(),
                    reason: e.to_string(),
                }),
            }
        }
        Ok(report)
    }

    /// 显式索引一张本机图片并返回其记录。重复调用返回相同记录；
    /// 用户明确重新添加已从库中移除的图片时，会解除来源扫描的忽略标记。
    pub fn import_file(&self, path: &Path, folder_id: Option<&str>) -> LibResult<Wallpaper> {
        let _guard = self.import_lock.lock();
        if !path.is_absolute() {
            return Err(LibError::Io("图片路径必须是绝对路径".into()));
        }
        let canonical = canonical_source(path)?;
        if !canonical.is_file() {
            return Err(LibError::NotFound(canonical.display().to_string()));
        }
        if !image_ops::is_supported(&canonical) {
            return Err(LibError::Unsupported(canonical.display().to_string()));
        }
        if let Some(fid) = folder_id {
            if self.db.get_folder(fid)?.is_none() {
                return Err(LibError::Io("目标文件夹不存在".into()));
            }
        }

        let source_key = canonical.to_string_lossy().to_string();
        let (_, wallpaper) = self.import_one(&canonical, folder_id)?;
        self.db.unexclude(&source_key)?;
        Ok(wallpaper)
    }

    /// 把目录展开为图片文件列表。非递归深度限制在 4 层，防止误选整块磁盘。
    fn expand(&self, paths: &[PathBuf]) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for p in paths {
            if p.is_dir() {
                collect_images(p, 0, &mut out);
            } else if image_ops::is_supported(p) {
                out.push(p.clone());
            }
        }
        out
    }

    /// 原文件索引：先读取头信息写库，缩略图稍后由后台补齐。
    fn import_one(&self, source: &Path, folder_id: Option<&str>) -> LibResult<(u8, Wallpaper)> {
        if !source.is_file() { return Err(LibError::NotFound(source.display().to_string())); }
        if !image_ops::is_supported(source) { return Err(LibError::Unsupported(source.display().to_string())); }
        let canonical = canonical_source(source)?;
        let source_key = canonical.to_string_lossy().to_string();
        let stamp = source_stamp(&canonical)?;
        if let Some(mut existing) = self.db.find_by_source(&source_key)? {
            if existing.storage_kind != "indexed" || existing.source_stamp == stamp { return Ok((0, existing.into())); }
            let (width, height) = image_ops::oriented_dimensions(&canonical)?;
            existing.width = width; existing.height = height;
            existing.bytes = std::fs::metadata(&canonical)?.len();
            existing.source_stamp = stamp;
            self.db.update_index(&existing)?;
            let _ = std::fs::remove_file(&existing.thumb_path);
            return Ok((2, existing.into()));
        }
        let (width, height) = image_ops::oriented_dimensions(&canonical)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let record = WallpaperRecord {
            thumb_path: image_ops::thumb_file_path(&self.root, &id).to_string_lossy().to_string(),
            name: canonical.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "未命名".into()),
            id, file_path: source_key.clone(), source_path: source_key, width, height,
            bytes: std::fs::metadata(&canonical)?.len(), created_at: chrono_now(), folder_id: folder_id.map(str::to_owned),
            storage_kind: "indexed".into(), source_stamp: stamp, cached_path: None,
        };
        self.db.insert(&record)?;
        Ok((1, record.into()))
    }

    /// 投放时才按当前源文件版本生成规范化副本。旧版本保留供仍在使用它的绑定恢复。
    pub fn prepare_wallpaper(&self, id: &str) -> LibResult<String> {
        let _guard = self.render_lock.lock();
        let rec = self.db.get(id)?.ok_or_else(|| LibError::NotFound("壁纸记录不存在".into()))?;
        let source = Path::new(&rec.file_path);
        if !source.is_file() { return Err(LibError::NotFound("原文件已移动或离线，请重新定位来源；当前桌面的投放缓存会保留".into())); }
        // 文件在应用外发生变化时，先刷新索引，后续列表会使用新元数据。
        if rec.storage_kind == "indexed" && rec.source_stamp != source_stamp(source)? { self.import(&[source.to_path_buf()], rec.folder_id.as_deref())?; }
        let stamp = source_stamp(source)?;
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        stamp.hash(&mut hash);
        let base = self.root.join("rendered").join(id).join(format!("{:016x}", hash.finish()));
        for ext in ["jpg", "png"] {
            let path = base.with_extension(ext);
            if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                let result = path.to_string_lossy().to_string();
                self.db.cache_path(id, &result)?;
                return Ok(result);
            }
        }
        let temporary_base = base.with_file_name(format!("pending-{}", uuid::Uuid::new_v4().simple()));
        let temporary = if rec.storage_kind == "managed" {
            let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
            let temporary = temporary_base.with_extension(extension);
            if let Some(parent) = temporary.parent() { std::fs::create_dir_all(parent)?; }
            std::fs::copy(source, &temporary)?;
            temporary
        } else {
            let image = image_ops::load_oriented(source)?;
            image_ops::normalize_for_wallpaper(&image, &temporary_base)?.0
        };
        if source_stamp(source)? != stamp {
            let _ = std::fs::remove_file(&temporary);
            return Err(LibError::Io("生成缓存期间原文件发生变化，请重新应用".into()));
        }
        let path = base.with_extension(temporary.extension().and_then(|s| s.to_str()).unwrap_or("jpg"));
        std::fs::rename(&temporary, &path)?;
        let result = path.to_string_lossy().to_string();
        self.db.cache_path(id, &result)?;
        Ok(result)
    }

    /// 原图预览按记录 ID 读取，不扩大 asset 协议白名单。
    pub fn original_bytes(&self, id: &str) -> LibResult<Vec<u8>> {
        let rec = self.db.get(id)?.ok_or_else(|| LibError::NotFound("壁纸记录不存在".into()))?;
        let path = Path::new(&rec.file_path);
        let bytes = std::fs::read(path)?;
        let format = image::guess_format(&bytes).map_err(|e| LibError::Decode(e.to_string()))?;
        if matches!(format, image::ImageFormat::Tiff) {
            let img = image_ops::load_oriented(path)?;
            let mut buffer = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buffer, image::ImageFormat::Png).map_err(|e| LibError::Encode(e.to_string()))?;
            return Ok(buffer.into_inner());
        }
        Ok(bytes)
    }

    /// 在线图片同样转码、生成缩略图并存入库，投放不依赖远程地址。
    pub fn import_online(&self, source_url: &str, name: &str, bytes: &[u8], folder_id: Option<&str>) -> LibResult<(Wallpaper, bool)> {
        let _guard = self.import_lock.lock();
        if let Some(fid) = folder_id {
            if self.db.get_folder(fid)?.is_none() { return Err(LibError::Io("目标文件夹不存在".into())); }
        }
        if let Some(record) = self.db.find_by_source(source_url)? { return Ok((record.into(), false)); }
        let img = image_ops::load_oriented_bytes(bytes)?;
        self.store_image(&img, source_url, name, folder_id).map(|wallpaper| (wallpaper, true))
    }

    fn store_image(&self, img: &image::DynamicImage, source_key: &str, name: &str, folder_id: Option<&str>) -> LibResult<Wallpaper> {

        let id = uuid::Uuid::new_v4().simple().to_string();
        // 不带扩展名的基路径，实际扩展名由 normalize_for_wallpaper 依内容决定
        let file_base = image_ops::library_file_base(&self.root, &id);
        let thumb_path = image_ops::thumb_file_path(&self.root, &id);

        let (file_path, width, height) = image_ops::normalize_for_wallpaper(img, &file_base)?;

        if let Some(parent) = thumb_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LibError::Io(format!("创建缩略图目录失败：{e}")))?;
        }
        let thumb_bytes = image_ops::make_thumbnail(img)?;
        std::fs::write(&thumb_path, &thumb_bytes)
            .map_err(|e| LibError::Io(format!("写入缩略图失败：{e}")))?;

        let bytes = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

        let record = WallpaperRecord {
            id,
            file_path: file_path.to_string_lossy().to_string(),
            thumb_path: thumb_path.to_string_lossy().to_string(),
            source_path: source_key.to_string(),
            name: name.to_string(),
            width,
            height,
            bytes,
            created_at: chrono_now(),
            folder_id: folder_id.map(|s| s.to_string()),
            storage_kind: "managed".into(), source_stamp: String::new(), cached_path: None,
        };
        self.db.insert(&record)?;
        Ok(record.into())
    }

    /// 从库中移除。同时删除库内副本与缩略图，但**不碰**用户的原始文件。
    pub fn remove(&self, id: &str) -> LibResult<()> {
        if let Some(rec) = self.db.get(id)? {
            if rec.storage_kind == "indexed" { self.db.exclude(&rec.source_path)?; }
            let in_use = self.db.load_bindings()?.iter().any(|binding| binding.wallpaper_id.as_deref() == Some(id)
                && binding.rendered_path.as_deref().unwrap_or(&rec.file_path) == rec.file_path);
            // 仅当路径确实位于库根目录内才删除，防止异常数据导致误删用户文件
            let mut owned = vec![&rec.thumb_path];
            if rec.storage_kind == "managed" && !in_use { owned.push(&rec.file_path); }
            for p in owned {
                let path = Path::new(p);
                if path.starts_with(&self.root) && path.exists() {
                    std::fs::remove_file(path).ok();
                }
            }
            // 兜底清理同基名的另一格式（png/jpg 切换时可能留下孤儿文件）
            if rec.storage_kind == "managed" && !in_use {
            let base = Path::new(&rec.file_path).with_extension("");
            for ext in ["png", "jpg"] {
                let alt = base.with_extension(ext);
                if alt.starts_with(&self.root) && alt.exists() {
                    std::fs::remove_file(alt).ok();
                }
            }
            }
        }
        self.db.delete(id)?;
        Ok(())
    }

    // ---------------- 文件夹 ----------------

    /// 补齐缺失或损坏的缩略图，返回成功重建的数量。
    ///
    /// # 为什么需要它
    ///
    /// 缩略图是派生文件，会因以下原因丢失：用户手动清理过库目录、
    /// 拷贝库到新机器时漏了 `thumbs/`、上次写入时磁盘写满。
    /// 一旦缺失，列表里就是一片灰色空块，看起来像「应用坏了」。
    /// 原图还在，重建成本很低，因此启动后静默自愈，不打扰用户。
    ///
    /// 判据是「文件不存在」或「文件为 0 字节」，不校验图片完整性——
    /// 逐张解码校验会让启动明显变慢，收益不成比例。
    pub fn repair_thumbnails(&self) -> LibResult<usize> {
        self.repair_thumbnails_with_progress(|_| {})
    }

    /// 清理过期派生缓存。锁顺序为 render -> import -> repair：prepare_wallpaper
    /// 已使用 render -> import；导入不获取 render，修复只获取 repair，因此不会形成环。
    pub fn cleanup_caches(&self, protected_paths: &[String]) -> LibResult<CacheCleanupReport> {
        let _render = self.render_lock.lock();
        let _import = self.import_lock.lock();
        let _repair = self.repair_lock.lock();

        let root = std::fs::canonicalize(&self.root)
            .map_err(|e| LibError::Io(format!("解析应用数据目录失败：{e}")))?;
        let mut referenced = Vec::<PathBuf>::new();
        for record in self.db.list()? {
            referenced.push(PathBuf::from(record.file_path));
            referenced.push(PathBuf::from(record.thumb_path));
            if let Some(path) = record.cached_path { referenced.push(PathBuf::from(path)); }
        }
        for binding in self.db.load_bindings()? {
            if let Some(path) = binding.rendered_path { referenced.push(PathBuf::from(path)); }
        }
        let mut protected = Vec::<PathBuf>::new();
        referenced.extend(protected_paths.iter().map(PathBuf::from));
        for candidate in &referenced {
            if let Ok(canonical) = std::fs::canonicalize(candidate) { protected.push(canonical); }
        }

        let mut report = CacheCleanupReport::default();
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
        // 先检查所有目标目录，再执行任何删除，避免后续目录异常导致部分清理却无法返回统计。
        let mut targets = Vec::new();
        for folder in ["previews", "thumbs", "rendered"] {
            let folder_path = self.root.join(folder);
            let metadata = match std::fs::symlink_metadata(&folder_path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(LibError::Io(format!("检查缓存目录失败：{error}"))),
            };
            if is_reparse_or_symlink(&metadata) || !metadata.is_dir() {
                return Err(LibError::Io(format!("拒绝清理：缓存目录 {} 是联接、符号链接或非目录", folder_path.display())));
            }
            let canonical_folder = std::fs::canonicalize(&folder_path)
                .map_err(|e| LibError::Io(format!("解析缓存目录失败：{e}")))?;
            if !canonical_folder.starts_with(&root) || canonical_folder != root.join(folder) {
                return Err(LibError::Io(format!("拒绝清理：缓存目录 {} 指向应用数据目录之外", folder_path.display())));
            }
            targets.push((folder_path, canonical_folder));
        }
        for (folder_path, canonical_folder) in targets {
            let files = collect_paths(&folder_path, &mut report)?;
            for path in files {
                let metadata = match std::fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => { report.failed_files += 1; continue; }
                };
                if !metadata.is_file() || is_reparse_or_symlink(&metadata) || !is_cache_image(&path) {
                    report.skipped_files += 1;
                    continue;
                }
                let modified = match metadata.modified() {
                    Ok(time) => time,
                    Err(_) => { report.skipped_files += 1; continue; }
                };
                if modified > cutoff { report.skipped_files += 1; continue; }
                let canonical = match std::fs::canonicalize(&path) {
                    Ok(path) => path,
                    Err(_) => { report.failed_files += 1; continue; }
                };
                if !canonical.starts_with(&canonical_folder) || !canonical.starts_with(&root) {
                    report.skipped_files += 1;
                    continue;
                }
                if protected.iter().any(|p| p == &canonical) {
                    report.skipped_files += 1;
                    continue;
                }
                match std::fs::remove_file(&path) {
                    Ok(()) => { report.removed_files += 1; report.freed_bytes = report.freed_bytes.saturating_add(metadata.len()); }
                    Err(_) => report.failed_files += 1,
                }
            }
        }
        Ok(report)
    }

    pub fn repair_thumbnails_with_progress(&self, mut progress: impl FnMut(Vec<String>)) -> LibResult<usize> {
        let _guard = self.repair_lock.lock();
        let mut fixed = 0;
        let mut pending = Vec::new();
        let mut last_progress = std::time::Instant::now();
        for rec in self.db.list()? {
            let thumb = Path::new(&rec.thumb_path);
            let healthy = thumb
                .metadata()
                .map(|m| m.len() > 0)
                .unwrap_or(false);
            if healthy {
                continue;
            }

            // 原图也没了就没有可恢复的余地，跳过（删除由用户显式发起）
            let src = Path::new(&rec.file_path);
            if !src.exists() {
                continue;
            }

            let img = match image_ops::load_oriented(src) {
                Ok(i) => i,
                Err(_) => continue,
            };
            if let Some(parent) = thumb.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(bytes) = image_ops::make_thumbnail(&img) {
                // 源在后台解码期间被重定位、更新或移除时，不能写回旧缩略图。
                let still_current = self.db.get(&rec.id)?.map(|now| now.source_stamp == rec.source_stamp && now.file_path == rec.file_path).unwrap_or(false);
                if !still_current || (rec.storage_kind == "indexed" && source_stamp(src).ok().as_deref() != Some(&rec.source_stamp)) { continue; }
                if std::fs::write(thumb, bytes).is_ok() {
                    fixed += 1;
                    pending.push(rec.id);
                    if fixed == 1 || pending.len() >= 4 || last_progress.elapsed().as_millis() >= 500 {
                        progress(std::mem::take(&mut pending));
                        last_progress = std::time::Instant::now();
                    }
                }
            }
        }
        if !pending.is_empty() { progress(pending); }
        Ok(fixed)
    }

    /// 预扫描目录：只统计会导入哪些图片，不写入任何东西。
    ///
    /// 供「添加本机文件夹」在真正导入前先告诉用户「这里有 128 张图」，
    /// 避免用户对着一个深目录点了导入才发现要跑很久。
    pub fn scan_folder(&self, dir: &Path) -> LibResult<FolderScan> {
        if !dir.is_dir() {
            return Err(LibError::NotFound(dir.display().to_string()));
        }
        let files = self.expand(&[dir.to_path_buf()]);
        let already: usize = files
            .iter()
            .filter(|p| {
                let key = canonical_source(p)
                    .unwrap_or_else(|_| (*p).clone())
                    .to_string_lossy()
                    .to_string();
                self.db.find_by_source(&key).ok().flatten().is_some()
            })
            .count();

        Ok(FolderScan {
            path: dir.to_string_lossy().to_string(),
            total: files.len(),
            already_in_library: already,
        })
    }

    /// 导入整个目录（递归）。返回的报告中 `skipped` 即「已在库中」的张数。
    pub fn import_folder(&self, dir: &Path, folder_id: Option<&str>) -> LibResult<ImportReport> {
        if !dir.is_dir() {
            return Err(LibError::NotFound(dir.display().to_string()));
        }
        let canonical = canonical_source(dir)?;
        let report = self.import(&[canonical.clone()], folder_id)?;
        self.db.save_source(&super::model::SourceFolder { id: uuid::Uuid::new_v4().simple().to_string(),
            path: canonical.to_string_lossy().to_string(), folder_id: folder_id.map(str::to_owned), available: true })?;
        Ok(report)
    }

    pub fn create_folder(&self, name: &str, parent_id: Option<&str>) -> LibResult<Folder> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(LibError::Io("文件夹名称不能为空".into()));
        }
        // 同级重名直接拒绝：目录树上两个同名节点无法区分，是纯粹的困惑来源
        let siblings = self.db.list_folders()?;
        if siblings
            .iter()
            .any(|f| f.parent_id.as_deref() == parent_id && f.name.eq_ignore_ascii_case(trimmed))
        {
            return Err(LibError::Io(format!("同级已存在名为「{trimmed}」的文件夹")));
        }

        if let Some(pid) = parent_id {
            if self.db.get_folder(pid)?.is_none() {
                return Err(LibError::Io("父文件夹不存在".into()));
            }
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        self.db.create_folder(&id, trimmed, parent_id)?;
        self.db
            .get_folder(&id)?
            .ok_or_else(|| LibError::Db("创建文件夹后读取失败".into()))
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> LibResult<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(LibError::Io("文件夹名称不能为空".into()));
        }
        let folder = self.db.get_folder(id)?
            .ok_or_else(|| LibError::NotFound("文件夹不存在".into()))?;
        if self.db.list_folders()?.iter().any(|f| {
            f.id != id && f.parent_id == folder.parent_id && f.name.eq_ignore_ascii_case(trimmed)
        }) {
            return Err(LibError::Io(format!("同级已存在名为「{trimmed}」的文件夹")));
        }
        self.db.rename_folder(id, trimmed)
    }

    /// 删除文件夹。内部壁纸上移到父级，不随之删除。
    pub fn delete_folder(&self, id: &str) -> LibResult<()> {
        self.db.delete_folder(id)
    }

    pub fn folder_tree(&self) -> LibResult<Vec<FolderNode>> {
        self.db.folder_tree()
    }

    /// 按文件夹筛选。`recursive` 为真时包含所有子文件夹。
    pub fn list_in_folder(&self, folder_id: &str, recursive: bool) -> LibResult<Vec<Wallpaper>> {
        let ids = if recursive {
            self.db.collect_subtree_ids(folder_id)?
        } else {
            vec![folder_id.to_string()]
        };
        Ok(self
            .db
            .list_by_folders(&ids)?
            .into_iter()
            .map(Wallpaper::from)
            .collect())
    }

    /// 未归入任何文件夹的壁纸。
    pub fn list_root_wallpapers(&self) -> LibResult<Vec<Wallpaper>> {
        Ok(self
            .db
            .list()?
            .into_iter()
            .filter(|r| r.folder_id.is_none())
            .map(Wallpaper::from)
            .collect())
    }

    /// 把壁纸移动到文件夹（`None` 为根目录）。
    pub fn move_to_folder(&self, id: &str, folder_id: Option<&str>) -> LibResult<()> {
        if let Some(fid) = folder_id {
            if self.db.get_folder(fid)?.is_none() {
                return Err(LibError::Io("目标文件夹不存在".into()));
            }
        }
        self.db.move_to_folder(id, folder_id)
    }

    pub fn rename(&self, id: &str, name: &str) -> LibResult<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(LibError::Io("名称不能为空".into()));
        }
        self.db.rename(id, trimmed)?;
        Ok(())
    }
}

fn is_cache_image(path: &Path) -> bool {
    matches!(path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("jpg" | "jpeg" | "png"))
}

fn is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    { false }
}

/// 遍历缓存子树，但从不跟随符号链接 / junction，也不返回目录用于删除。
fn collect_paths(root: &Path, report: &mut CacheCleanupReport) -> LibResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => { report.failed_files += 1; continue; }
        };
        for entry in entries {
            let entry = match entry { Ok(entry) => entry, Err(_) => { report.failed_files += 1; continue; } };
            let path = entry.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => { report.failed_files += 1; continue; }
            };
            if is_reparse_or_symlink(&metadata) { report.skipped_files += 1; continue; }
            if metadata.is_dir() { pending.push(path); }
            else { files.push(path); }
        }
    }
    Ok(files)
}

fn directory_size_safe(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(metadata) = std::fs::symlink_metadata(&dir) else { continue; };
        if is_reparse_or_symlink(&metadata) || !metadata.is_dir() { continue; }
        let Ok(entries) = std::fs::read_dir(dir) else { continue; };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&entry_path) else { continue; };
            if is_reparse_or_symlink(&metadata) { continue; }
            if metadata.is_dir() { pending.push(entry_path); }
            else if metadata.is_file() { total = total.saturating_add(metadata.len()); }
        }
    }
    total
}

/// 递归收集图片，`depth` 限制防止过深目录。
fn canonical_source(path: &Path) -> LibResult<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    #[cfg(windows)] {
        let text = path.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { return Ok(PathBuf::from(format!(r"\\{unc}"))); }
        if let Some(local) = text.strip_prefix(r"\\?\") { return Ok(PathBuf::from(local)); }
    }
    Ok(path)
}

fn source_stamp(path: &Path) -> LibResult<String> {
    let metadata = path.metadata()?;
    let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or(0);
    Ok(format!("{}-{modified}", metadata.len()))
}

fn collect_images(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, depth + 1, out);
        } else if image_ops::is_supported(&path) {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 缩略图渐进通知只包含已生成图片且不重复() {
        let root = temp_root("progressive-thumbnails");
        let sources: Vec<_> = (0..6).map(|i| write_png(&root, &format!("{i}.png"))).collect();
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&sources, None).unwrap();
        let mut batches = Vec::new();
        let fixed = lib.repair_thumbnails_with_progress(|ids| {
            assert!(ids.iter().all(|id| Path::new(&lib.db().get(id).unwrap().unwrap().thumb_path).is_file()));
            batches.push(ids);
        }).unwrap();
        assert_eq!(fixed, 6);
        assert_eq!(batches[0].len(), 1);
        let all: std::collections::HashSet<_> = batches.into_iter().flatten().collect();
        assert_eq!(all.len(), 6);
        assert_eq!(lib.repair_thumbnails_with_progress(|_| panic!("健康缩略图不应再通知")).unwrap(), 0);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
    use image::{Rgba, RgbaImage};
    use super::super::model::MonitorBinding;

    fn set_modified(path: &Path, time: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(time)).unwrap();
    }

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("dwd-test-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        // 与生产路径使用同一规范形式，避免 Windows 临时目录短路径别名导致断言不一致。
        canonical_source(&p).unwrap()
    }

    fn write_png(dir: &Path, name: &str) -> PathBuf {
        let img = RgbaImage::from_pixel(64, 40, Rgba([12, 200, 90, 255]));
        let p = dir.join(name);
        img.save(&p).unwrap();
        p
    }

    #[test]
    fn 缓存目录联接被整体拒绝且统计不穿透外部目录() {
        let root = temp_root("cache-junction-reject");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let external = outside.join("keep.jpg");
        std::fs::write(&external, b"external").unwrap();
        let data = root.join("data");
        let lib = Library::open(data.clone()).unwrap();
        let preview = data.join("previews").join("old.png");
        std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
        std::fs::write(&preview, b"preview").unwrap();
        set_modified(&preview, std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60));
        let linked = data.join("thumbs");
        #[cfg(windows)] std::os::windows::fs::symlink_dir(&outside, &linked).unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&outside, &linked).unwrap();
        assert_eq!(lib.storage().unwrap().thumbnail_bytes, 0);
        assert!(lib.cleanup_caches(&[]).is_err());
        assert!(preview.exists(), "任何删除之前就必须拒绝异常目录");
        assert_eq!(std::fs::read(&external).unwrap(), b"external");
        drop(lib);
        #[cfg(windows)] std::fs::remove_dir(&linked).unwrap();
        #[cfg(unix)] std::fs::remove_file(&linked).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 缓存清理只回收过期孤儿并保护引用当前壁纸和外部联接且可重复执行() {
        let root = temp_root("cache-cleanup");
        let source = write_png(&root, "source.png");
        let outside = write_png(&root, "outside.png");
        let lib = Library::open(root.join("data")).unwrap();
        let wallpaper = lib.import_file(&source, None).unwrap();
        let data = root.join("data");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);

        let referenced_thumb = PathBuf::from(&wallpaper.thumb_path);
        std::fs::create_dir_all(referenced_thumb.parent().unwrap()).unwrap();
        std::fs::write(&referenced_thumb, b"thumb").unwrap();
        set_modified(&referenced_thumb, old);
        let cached = data.join("rendered").join("cached.jpg");
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, b"cached").unwrap();
        set_modified(&cached, old);
        lib.db().cache_path(&wallpaper.id, &cached.to_string_lossy()).unwrap();

        let bound = data.join("rendered").join("bound.png");
        std::fs::write(&bound, b"binding").unwrap();
        set_modified(&bound, old);
        lib.db().save_bindings(&[MonitorBinding {
            identity: "test-monitor".into(), wallpaper_id: Some(wallpaper.id.clone()),
            position: "fill".into(), rendered_path: Some(bound.to_string_lossy().into_owned()),
        }]).unwrap();

        let current = data.join("rendered").join("current.jpg");
        std::fs::write(&current, b"current").unwrap();
        set_modified(&current, old);
        let orphan = data.join("rendered").join("nested").join("orphan.jpg");
        std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        std::fs::write(&orphan, b"12345").unwrap();
        set_modified(&orphan, old);
        let preview = data.join("previews").join("expired.png");
        std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
        std::fs::write(&preview, b"123").unwrap();
        set_modified(&preview, old);
        let fresh = data.join("thumbs").join("fresh.jpg");
        std::fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        std::fs::write(&fresh, b"fresh").unwrap();
        let orphan_thumb = data.join("thumbs").join("orphan.png");
        std::fs::write(&orphan_thumb, b"1234").unwrap();
        set_modified(&orphan_thumb, old);
        let tmp = data.join("rendered").join("pending.tmp");
        std::fs::write(&tmp, b"tmp").unwrap();
        set_modified(&tmp, old);
        let symlink = data.join("rendered").join("external.jpg");
        #[cfg(windows)] std::os::windows::fs::symlink_file(&outside, &symlink).unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&outside, &symlink).unwrap();

        assert_eq!(lib.storage().unwrap().thumbnail_bytes, 14);
        let report = lib.cleanup_caches(&[current.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(report.removed_files, 3);
        assert_eq!(report.freed_bytes, 12);
        assert!(report.skipped_files >= 5);
        assert_eq!(report.failed_files, 0);
        for protected in [&referenced_thumb, &cached, &bound, &current, &fresh, &tmp, &symlink, &outside] {
            assert!(protected.exists(), "must remain: {}", protected.display());
        }
        assert!(!orphan.exists());
        assert!(!orphan_thumb.exists());
        assert!(!preview.exists());
        assert_eq!(lib.storage().unwrap().thumbnail_bytes, 10);
        let again = lib.cleanup_caches(&[current.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(again.removed_files, 0);
        assert_eq!(again.freed_bytes, 0);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 壁纸详情读取文件元数据并在缺失时保留索引信息() {
        let root = temp_root("wallpaper-details");
        let source = write_png(&root, "原图.PNG");
        let lib = Library::open(root.join("data")).unwrap();
        let wallpaper = lib.import_file(&source, None).unwrap();
        let metadata = source.metadata().unwrap();
        let as_unix_seconds = |time: std::time::SystemTime| -> i64 {
            match time.duration_since(std::time::UNIX_EPOCH) {
                Ok(duration) => duration.as_secs() as i64,
                Err(error) => -(error.duration().as_secs() as i64),
            }
        };

        let details = lib.wallpaper_details(&wallpaper.id).unwrap();
        assert_eq!(details.file_name, "原图.PNG");
        assert_eq!(details.extension, "png");
        assert_eq!(details.parent_path, root.to_string_lossy());
        assert_eq!((details.width, details.height), (64, 40));
        assert_eq!(details.bytes, metadata.len());
        assert_eq!(details.indexed_at, lib.db().get(&wallpaper.id).unwrap().unwrap().created_at);
        assert_eq!(details.file_created_at, metadata.created().ok().map(as_unix_seconds));
        assert_eq!(details.file_modified_at, metadata.modified().ok().map(as_unix_seconds));
        assert!(details.exists);
        assert_eq!(details.storage_kind, "indexed");

        std::fs::remove_file(&source).unwrap();
        let missing = lib.wallpaper_details(&wallpaper.id).unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.bytes, wallpaper.bytes);
        assert_eq!(missing.file_created_at, None);
        assert_eq!(missing.file_modified_at, None);
        assert_eq!(missing.width, wallpaper.width);
        assert_eq!(missing.height, wallpaper.height);
        assert!(lib.wallpaper_details("unknown-wallpaper-id").is_err());

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 壁纸资源管理器定位目标仅从库记录解析() {
        let root = temp_root("wallpaper-reveal-target");
        let source = write_png(&root, "reveal.png");
        let lib = Library::open(root.join("data")).unwrap();
        let wallpaper = lib.import_file(&source, None).unwrap();
        assert_eq!(lib.wallpaper_reveal_target(&wallpaper.id).unwrap(), source);

        std::fs::remove_file(&source).unwrap();
        assert_eq!(lib.wallpaper_reveal_target(&wallpaper.id).unwrap(), root);
        assert!(lib.wallpaper_reveal_target("unknown-wallpaper-id").is_err());

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 在线图片按来源去重并保留本地副本() {
        let root = temp_root("online-import");
        let lib = Library::open(root.join("data")).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(80, 50).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let source = "https://wallhaven.cc/w/abc123";
        let (wallpaper, added) = lib.import_online(source, "在线风景", bytes.get_ref(), None).unwrap();
        assert!(added);
        assert!(Path::new(&wallpaper.file_path).is_file());
        assert!(wallpaper.file_path.ends_with(".jpg"));
        assert!(Path::new(&wallpaper.thumb_path).is_file());
        assert_eq!(lib.db.find_by_source(source).unwrap().unwrap().name, "在线风景");
        let (duplicate, added) = lib.import_online(source, "再次下载", bytes.get_ref(), None).unwrap();
        assert_eq!(duplicate.id, wallpaper.id);
        assert!(!added);
        assert_eq!(lib.list().unwrap().len(), 1);
        assert!(lib.import_online("https://example.test/bad", "坏图", b"not an image", None).is_err());
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 并发导入同一在线图片只新增一次() {
        let root = temp_root("online-concurrent");
        let lib = std::sync::Arc::new(Library::open(root.join("data")).unwrap());
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(30, 20).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let threads: Vec<_> = (0..2).map(|_| {
            let lib = lib.clone();
            let bytes = bytes.get_ref().clone();
            std::thread::spawn(move || lib.import_online("https://wallhaven.cc/w/abc123", "测试", &bytes, None).unwrap().1)
        }).collect();
        let added = threads.into_iter().filter_map(|t| t.join().ok()).filter(|added| *added).count();
        assert_eq!(added, 1);
        assert_eq!(lib.list().unwrap().len(), 1);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 未绑定的托管壁纸删除原副本但保留独立投放缓存() {
        let root = temp_root("managed-remove-unbound");
        let lib = Library::open(root.join("data")).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(80, 50)
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .unwrap();
        let (wallpaper, added) = lib.import_online(
            "https://wallhaven.cc/w/managed-unbound",
            "托管未绑定",
            bytes.get_ref(),
            None,
        ).unwrap();
        assert!(added);
        let original = PathBuf::from(&wallpaper.file_path);
        let rendered = PathBuf::from(lib.prepare_wallpaper(&wallpaper.id).unwrap());
        assert!(original.is_file());
        assert!(rendered.is_file());
        assert_ne!(original, rendered);
        assert_eq!(std::fs::read(&original).unwrap(), std::fs::read(&rendered).unwrap(), "托管壁纸缓存应直接复制规范化文件");

        lib.remove(&wallpaper.id).unwrap();

        assert!(!original.exists(), "未绑定的托管副本应删除");
        assert!(rendered.exists(), "投放缓存应独立保留");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 旧式绑定无rendered_path时删除仍保留托管原副本() {
        let root = temp_root("managed-remove-legacy-binding");
        let lib = Library::open(root.join("data")).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(80, 50)
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .unwrap();
        let (wallpaper, added) = lib.import_online(
            "https://wallhaven.cc/w/managed-bound",
            "托管旧绑定",
            bytes.get_ref(),
            None,
        ).unwrap();
        assert!(added);
        let original = PathBuf::from(&wallpaper.file_path);
        let rendered = PathBuf::from(lib.prepare_wallpaper(&wallpaper.id).unwrap());
        lib.db.save_bindings(&[MonitorBinding {
            identity: "legacy-monitor".into(),
            wallpaper_id: Some(wallpaper.id.clone()),
            position: "fill".into(),
            rendered_path: None,
        }]).unwrap();

        lib.remove(&wallpaper.id).unwrap();

        assert!(original.exists(), "旧式绑定仍以 file_path 投放，必须保留原副本");
        assert!(rendered.exists(), "独立投放缓存也应保留");
        assert!(lib.list().unwrap().is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 导入后只索引原文件并可列出() {
        let root = temp_root("import");
        let src_dir = root.join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = write_png(&src_dir, "a.png");

        let lib = Library::open(root.join("data")).unwrap();
        let report = lib.import(&[src.clone()], None).unwrap();
        assert_eq!(report.added, 1);

        let list = lib.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].width, 64);

        // 本机导入只登记原文件路径；不会复制原图，也不会立即生成缩略图。
        assert_eq!(Path::new(&list[0].file_path), src);
        assert!(Path::new(&list[0].file_path).exists());
        assert_eq!(list[0].storage_kind, "indexed");
        assert!(!Path::new(&list[0].thumb_path).exists());
        assert!(!root.join("data/files").exists());
        assert!(!root.join("data/rendered").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 重复导入同一文件被跳过() {
        let root = temp_root("dedup");
        let src = write_png(&root, "b.png");
        let lib = Library::open(root.join("data")).unwrap();

        assert_eq!(lib.import(&[src.clone()], None).unwrap().added, 1);
        let second = lib.import(&[src], None).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(lib.list().unwrap().len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 单文件导入返回记录并对同一路径去重且不复制原图() {
        let root = temp_root("import-file");
        let src = write_png(&root, "single.png");
        let original_bytes = std::fs::read(&src).unwrap();
        let lib = Library::open(root.join("data")).unwrap();

        let first = lib.import_file(&src, None).unwrap();
        let second = lib.import_file(&src, None).unwrap();

        assert_eq!(first.id, second.id, "重复导入应直接返回原记录");
        assert_eq!(first.storage_kind, "indexed");
        assert_eq!(Path::new(&first.file_path), canonical_source(&src).unwrap());
        assert_eq!(std::fs::read(&src).unwrap(), original_bytes, "导入不得改写原图");
        assert_eq!(lib.list().unwrap().len(), 1);
        assert!(!root.join("data/files").exists(), "本机原图不应复制到应用库");

        lib.remove(&first.id).unwrap();
        let readded = lib.import_file(&src, None).unwrap();
        assert_ne!(first.id, readded.id, "显式重新添加应创建新索引记录");
        assert!(!lib.db().excluded(&canonical_source(&src).unwrap().to_string_lossy()).unwrap());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 单文件导入拒绝相对路径缺失文件非图片和无效合集() {
        let root = temp_root("import-file-invalid");
        let src = write_png(&root, "valid.png");
        let unsupported = root.join("notes.txt");
        std::fs::write(&unsupported, b"not an image").unwrap();
        let lib = Library::open(root.join("data")).unwrap();

        assert!(lib.import_file(Path::new("relative.png"), None).unwrap_err().to_string().contains("绝对路径"));
        assert!(lib.import_file(&root.join("missing.png"), None).is_err());
        assert!(lib.import_file(&unsupported, None).unwrap_err().to_string().contains("不支持"));
        assert!(lib.import_file(&src, Some("missing-folder")).unwrap_err().to_string().contains("目标文件夹不存在"));
        assert!(lib.list().unwrap().is_empty());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 删除索引不会删除原图或投放缓存() {
        let root = temp_root("remove");
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let src = write_png(&data, "c.png");
        let lib = Library::open(data).unwrap();
        lib.import(&[src.clone()], None).unwrap();

        let wp = lib.list().unwrap().into_iter().next().unwrap();
        let cached = lib.prepare_wallpaper(&wp.id).unwrap();
        lib.repair_thumbnails().unwrap();
        let thumb = wp.thumb_path.clone();
        lib.remove(&wp.id).unwrap();

        assert!(lib.list().unwrap().is_empty());
        assert!(src.exists(), "即使原图位于应用数据目录，也不能由删除索引动作删除");
        assert!(Path::new(&cached).exists(), "已生成的投放缓存应保留");
        assert!(!Path::new(&thumb).exists(), "缩略图属于库管理文件，可清理");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 导入只索引原图并保留原始字节() {
        let root = temp_root("index-only");
        let src = write_png(&root, "original.png");
        let original = std::fs::read(&src).unwrap();
        let lib = Library::open(root.join("data")).unwrap();

        let report = lib.import(&[src.clone()], None).unwrap();
        let wp = lib.list().unwrap().remove(0);

        assert_eq!(report.added, 1);
        assert_eq!(std::fs::read(&src).unwrap(), original);
        assert_eq!(Path::new(&wp.file_path), src);
        assert_eq!(wp.storage_kind, "indexed");
        assert!(!Path::new(&wp.thumb_path).exists());
        assert!(!root.join("data/files").exists());
        assert!(!root.join("data/rendered").exists());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 源文件变化重扫更新元数据但保留身份名称与合集() {
        let root = temp_root("rescan-update");
        let source = root.join("photos");
        std::fs::create_dir_all(&source).unwrap();
        let src = write_png(&source, "mutable.png");
        let lib = Library::open(root.join("data")).unwrap();
        let folder = lib.create_folder("收藏", None).unwrap();
        lib.import_folder(&source, Some(&folder.id)).unwrap();
        let mut wp = lib.list().unwrap().remove(0);
        let original_id = wp.id.clone();
        lib.rename(&wp.id, "我的名字").unwrap();
        lib.repair_thumbnails().unwrap();
        let old_thumb = wp.thumb_path.clone();
        assert!(Path::new(&old_thumb).is_file());

        std::thread::sleep(std::time::Duration::from_millis(20));
        RgbaImage::from_pixel(91, 53, Rgba([200, 10, 40, 255])).save(&src).unwrap();
        let source_id = lib.db.source_folders().unwrap().remove(0).id;
        let report = lib.rescan_source(&source_id).unwrap();
        wp = lib.list().unwrap().remove(0);

        assert_eq!(report.updated, 1);
        assert_eq!(wp.id, original_id, "更新时必须保留原记录身份");
        assert_eq!(wp.name, "我的名字");
        assert_eq!(wp.folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!((wp.width, wp.height), (91, 53));
        assert!(!Path::new(&old_thumb).exists(), "源变化后旧缩略图应失效");

        std::fs::remove_file(&src).unwrap();
        let missing = lib.list().unwrap().remove(0);
        assert!(missing.missing);
        assert_eq!(lib.rescan_source(&source_id).unwrap().added, 0);
        assert_eq!(lib.list().unwrap().len(), 1, "来源文件缺失时仍保留记录");

        RgbaImage::from_pixel(91, 53, Rgba([20, 30, 40, 255])).save(&src).unwrap();
        lib.rescan_source(&source_id).unwrap();
        let restored = lib.list().unwrap().remove(0);
        assert!(!restored.missing, "来源恢复后记录应自动恢复可用");
        assert_eq!(restored.id, original_id);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 投放缓存按源版本复用且离线时保留但不能重新投放() {
        let root = temp_root("prepare-cache");
        let source = root.join("photos");
        std::fs::create_dir_all(&source).unwrap();
        let src = write_png(&source, "cache.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&[src.clone()], None).unwrap();
        let wp = lib.list().unwrap().remove(0);

        let first = lib.prepare_wallpaper(&wp.id).unwrap();
        let second = lib.prepare_wallpaper(&wp.id).unwrap();
        assert_eq!(first, second, "相同源版本应复用投放缓存");
        assert!(first.ends_with(".png"), "带 alpha 的源图应保留 PNG 格式");
        assert!(Path::new(&first).is_file());
        assert_eq!(lib.list().unwrap()[0].cached_path.as_deref(), Some(first.as_str()));

        std::fs::remove_file(&src).unwrap();
        let offline = lib.list().unwrap().remove(0);
        assert!(offline.missing);
        assert!(Path::new(&first).is_file(), "源离线后缓存仍供当前桌面使用");
        assert!(lib.prepare_wallpaper(&wp.id).is_err(), "源缺失时不允许新投放");

        image::RgbImage::from_pixel(75, 45, image::Rgb([20, 90, 170])).save(&src).unwrap();
        let source_id = lib.db.source_folders().unwrap();
        assert!(source_id.is_empty(), "单文件导入不登记目录来源");
        lib.import(&[src.clone()], None).unwrap();
        let restored = lib.list().unwrap().remove(0);
        assert!(!restored.missing);
        assert_eq!(restored.id, wp.id);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 文件夹来源重定位保留记录并在冲突时事务安全() {
        let root = temp_root("relocate-source");
        let old_dir = root.join("old");
        let new_dir = root.join("new");
        let conflicting_dir = root.join("conflicting");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::create_dir_all(&conflicting_dir).unwrap();
        let old_src = write_png(&old_dir, "same.png");
        let new_src = write_png(&new_dir, "same.png");
        write_png(&conflicting_dir, "same.png");
        let lib = Library::open(root.join("data")).unwrap();
        let folder = lib.create_folder("移动后仍在此合集", None).unwrap();
        lib.import_folder(&old_dir, Some(&folder.id)).unwrap();
        lib.import_folder(&conflicting_dir, None).unwrap();
        let records = lib.list().unwrap();
        let original = records.iter().find(|w| w.file_path == old_src.to_string_lossy()).unwrap().clone();
        let sources = lib.db.source_folders().unwrap();
        let old_source_id = sources.iter().find(|s| Path::new(&s.path) == canonical_source(&old_dir).unwrap()).unwrap().id.clone();

        assert!(lib.relocate_source(&old_source_id, &conflicting_dir).is_err());
        assert_eq!(Path::new(&lib.db.source_folders().unwrap().iter().find(|s| s.id == old_source_id).unwrap().path), canonical_source(&old_dir).unwrap());
        assert_eq!(lib.list().unwrap().len(), 2);
        assert!(lib.list().unwrap().iter().any(|w| w.id == original.id && w.file_path == original.file_path));

        let moved = lib.relocate_source(&old_source_id, &new_dir).unwrap();
        let relocated = lib.list().unwrap().into_iter().find(|w| w.id == original.id).unwrap();
        assert!(moved.updated >= 1);
        assert_eq!(Path::new(&relocated.file_path), canonical_source(&new_src).unwrap());
        assert_eq!(relocated.name, original.name);
        assert_eq!(relocated.folder_id, original.folder_id);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 从库中移除来源后重扫保持排除而显式单文件导入可重新加入() {
        let root = temp_root("excluded-source");
        let source = root.join("photos");
        std::fs::create_dir_all(&source).unwrap();
        let src = write_png(&source, "excluded.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import_folder(&source, None).unwrap();
        let original = lib.list().unwrap().remove(0);
        let source_id = lib.db.source_folders().unwrap().remove(0).id;

        lib.remove(&original.id).unwrap();
        let rescan = lib.rescan_source(&source_id).unwrap();
        assert_eq!(rescan.added, 0, "目录重扫不能加回用户已移除的来源图");
        assert!(lib.list().unwrap().is_empty());

        let explicit = lib.import(&[src], None).unwrap();
        assert_eq!(explicit.added, 1, "用户显式重新添加单图时可解除排除");
        assert_eq!(lib.list().unwrap().len(), 1);

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 来源迁移同时迁移排除路径且不加回已移除图片() {
        let root = temp_root("relocate-excluded");
        let old_dir = root.join("old-photos");
        let new_dir = root.join("new-photos");
        std::fs::create_dir_all(&old_dir).unwrap();
        let removed_src = write_png(&old_dir, "removed.png");
        let retained_src = write_png(&old_dir, "retained.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import_folder(&old_dir, None).unwrap();
        let records = lib.list().unwrap();
        let removed = records.iter().find(|w| w.name == "removed").unwrap();
        let retained = records.iter().find(|w| w.name == "retained").unwrap();
        let retained_id = retained.id.clone();
        let source_id = lib.db.source_folders().unwrap().remove(0).id;

        lib.remove(&removed.id).unwrap();
        std::fs::rename(&old_dir, &new_dir).unwrap();
        lib.relocate_source(&source_id, &new_dir).unwrap();
        let report = lib.rescan_source(&source_id).unwrap();

        let remaining = lib.list().unwrap();
        assert_eq!(report.added, 0, "重定位后的重扫不得加回已排除图片");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, retained_id, "另一张已索引图片保持原 ID");
        assert_eq!(Path::new(&remaining[0].file_path), canonical_source(&new_dir.join("retained.png")).unwrap());
        assert!(new_dir.join("removed.png").is_file());
        assert!(!removed_src.exists() && !retained_src.exists(), "目录移动后旧路径都应失效");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn 本机索引原图字节可读取且删除或不存在的编号被拒绝() {
        let root = temp_root("original-bytes");
        let src = write_png(&root, "original.png");
        let expected = std::fs::read(&src).unwrap();
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&[src], None).unwrap();
        let wallpaper = lib.list().unwrap().remove(0);

        assert_eq!(lib.original_bytes(&wallpaper.id).unwrap(), expected);
        assert!(lib.original_bytes("missing-wallpaper-id").is_err());
        lib.remove(&wallpaper.id).unwrap();
        assert!(lib.original_bytes(&wallpaper.id).is_err());

        std::fs::remove_dir_all(root).ok();
    }

    // ---------------- 文件夹 ----------------

    #[test]
    fn 缩略图丢失后可自动补齐() {
        let root = temp_root("thumb-repair");
        let src = write_png(&root, "e.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&[src], None).unwrap();

        let wp = lib.list().unwrap().into_iter().next().unwrap();
        // 索引导入不即时创建缩略图，由显式修复任务生成。
        assert!(!Path::new(&wp.thumb_path).exists());

        let fixed = lib.repair_thumbnails().unwrap();
        assert_eq!(fixed, 1, "应重建 1 张缩略图");
        assert!(Path::new(&wp.thumb_path).exists(), "缩略图应被重建");

        // 再跑一次不应重复处理
        assert_eq!(lib.repair_thumbnails().unwrap(), 0);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 扫描目录报告总数与已入库数量() {
        let root = temp_root("scan");
        let dir = root.join("photos");
        std::fs::create_dir_all(&dir).unwrap();
        let a = write_png(&dir, "a.png");
        let b = write_png(&dir, "b.png");
        // 非图片文件不应计入
        std::fs::write(dir.join("note.txt"), b"hello").unwrap();

        let lib = Library::open(root.join("data")).unwrap();
        let first = lib.scan_folder(&dir).unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.already_in_library, 0);

        lib.import_folder(&dir, None).unwrap();

        let second = lib.scan_folder(&dir).unwrap();
        assert_eq!(second.total, 2, "总数不变");
        assert_eq!(second.already_in_library, 2, "两张都已在库中");
        assert!(a.exists() && b.exists(), "扫描不复制也不删除源文件");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 文件夹可嵌套且穿透统计总数() {
        let root = temp_root("folder-tree");
        let src = write_png(&root, "d.png");
        let lib = Library::open(root.join("data")).unwrap();

        let top = lib.create_folder("风景", None).unwrap();
        let child = lib.create_folder("雪山", Some(&top.id)).unwrap();
        let grand = lib.create_folder("冬季", Some(&child.id)).unwrap();

        lib.import(&[src.clone()], Some(&grand.id)).unwrap();

        let tree = lib.folder_tree().unwrap();
        let by_id = |id: &str| tree.iter().find(|n| n.folder.id == id).unwrap();

        // 图片在最深层，三个层级的总数都应包含它；直接数量只有叶子为 1
        assert_eq!(by_id(&grand.id).total_count, 1);
        assert_eq!(by_id(&child.id).total_count, 1);
        assert_eq!(by_id(&top.id).total_count, 1);
        assert_eq!(by_id(&top.id).direct_count, 0);
        assert_eq!(by_id(&top.id).children, vec![child.id.clone()]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 穿透查询包含子文件夹非穿透则不含() {
        let root = temp_root("folder-recursive");
        let a = write_png(&root, "e.png");
        let b = write_png(&root, "f.png");
        let lib = Library::open(root.join("data")).unwrap();

        let parent = lib.create_folder("父", None).unwrap();
        let sub = lib.create_folder("子", Some(&parent.id)).unwrap();

        lib.import(&[a], Some(&parent.id)).unwrap();
        lib.import(&[b], Some(&sub.id)).unwrap();

        // 非穿透只看本层
        assert_eq!(lib.list_in_folder(&parent.id, false).unwrap().len(), 1);
        // 穿透则含子树
        assert_eq!(lib.list_in_folder(&parent.id, true).unwrap().len(), 2);
        assert_eq!(lib.list_in_folder(&sub.id, true).unwrap().len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 删除文件夹时壁纸上移而非连带删除() {
        let root = temp_root("folder-del");
        let src = write_png(&root, "g.png");
        let lib = Library::open(root.join("data")).unwrap();

        let parent = lib.create_folder("父", None).unwrap();
        let sub = lib.create_folder("子", Some(&parent.id)).unwrap();
        lib.import(&[src], Some(&sub.id)).unwrap();

        lib.delete_folder(&sub.id).unwrap();

        // 壁纸还在，且被移到父文件夹
        let list = lib.list_in_folder(&parent.id, false).unwrap();
        assert_eq!(list.len(), 1, "壁纸应上移到父文件夹");
        assert_eq!(list[0].folder_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(lib.list().unwrap().len(), 1, "壁纸不能被删除");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 删除父合集后子合集与各层壁纸完整保留() {
        let root = temp_root("folder-parent-delete");
        let first = write_png(&root, "first.png");
        let second = write_png(&root, "second.png");
        let lib = Library::open(root.join("data")).unwrap();
        let parent = lib.create_folder("父合集", None).unwrap();
        let child = lib.create_folder("子合集", Some(&parent.id)).unwrap();
        lib.import(&[first], Some(&parent.id)).unwrap();
        lib.import(&[second], Some(&child.id)).unwrap();
        lib.delete_folder(&parent.id).unwrap();
        let tree = lib.folder_tree().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].folder.id, child.id);
        assert!(tree[0].folder.parent_id.is_none());
        assert_eq!(lib.list_root_wallpapers().unwrap().len(), 1);
        assert_eq!(lib.list_in_folder(&child.id, false).unwrap().len(), 1);
        assert!(lib.list().unwrap().iter().all(|w| Path::new(&w.file_path).is_file()));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 同级重名文件夹被拒绝() {
        let root = temp_root("folder-dup");
        let lib = Library::open(root.join("data")).unwrap();

        lib.create_folder("城市", None).unwrap();
        assert!(lib.create_folder("城市", None).is_err());

        // 不同层级允许同名：目录树里路径不同，不会混淆
        let other = lib.create_folder("自然", None).unwrap();
        assert!(lib.create_folder("城市", Some(&other.id)).is_ok());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 重命名拒绝同级重名但允许自身与跨级同名() {
        let root = temp_root("folder-rename");
        let lib = Library::open(root.join("data")).unwrap();
        let first = lib.create_folder("Nature", None).unwrap();
        let second = lib.create_folder("City", None).unwrap();
        assert!(lib.rename_folder(&second.id, " nature ").is_err());
        assert!(lib.rename_folder(&first.id, " NATURE ").is_ok());
        let child = lib.create_folder("Child", Some(&first.id)).unwrap();
        assert!(lib.rename_folder(&child.id, "City").is_ok());
        assert!(lib.rename_folder("missing", "Name").is_err());
        assert_eq!(lib.db.get_folder(&second.id).unwrap().unwrap().name, "City");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 根目录查询只返回未归类壁纸() {
        let root = temp_root("folder-root");
        let a = write_png(&root, "h.png");
        let b = write_png(&root, "i.png");
        let lib = Library::open(root.join("data")).unwrap();
        let folder = lib.create_folder("已归类", None).unwrap();

        lib.import(&[a], None).unwrap();
        lib.import(&[b], Some(&folder.id)).unwrap();

        let root_list = lib.list_root_wallpapers().unwrap();
        assert_eq!(root_list.len(), 1);
        assert!(root_list[0].folder_id.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn 移动壁纸到文件夹与移回根目录() {
        let root = temp_root("folder-move");
        let src = write_png(&root, "j.png");
        let lib = Library::open(root.join("data")).unwrap();
        let folder = lib.create_folder("目标", None).unwrap();

        lib.import(&[src], None).unwrap();
        let wp = lib.list().unwrap().into_iter().next().unwrap();
        assert!(wp.folder_id.is_none());

        lib.move_to_folder(&wp.id, Some(&folder.id)).unwrap();
        assert_eq!(lib.list_in_folder(&folder.id, false).unwrap().len(), 1);

        lib.move_to_folder(&wp.id, None).unwrap();
        assert!(lib.list_root_wallpapers().unwrap().len() == 1);

        std::fs::remove_dir_all(&root).ok();
    }
}
