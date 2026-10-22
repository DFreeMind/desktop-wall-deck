//! 壁纸库服务：导入、列出、删除。
//!
//! 设计要点：
//!
//! 1. **入库即复制**。用户原始文件被复制进 app data 目录并转码为 PNG。
//!    这样用户删掉下载目录里的原图，壁纸不会失效——这是壁纸管理工具
//!    与「直接指向文件路径」的关键区别。
//! 2. **按源路径去重**。重复导入同一文件只跳过，不产生副本，避免磁盘膨胀。
//! 3. **批量导入逐条容错**。一张坏图不应让整批失败，失败原因逐条返回给 UI。

use std::path::{Path, PathBuf};

use super::db::{chrono_now, Db, WallpaperRecord};
use super::error::{LibError, LibResult};
use super::image_ops;
use super::model::{Folder, FolderNode, FolderScan, ImportFailure, ImportReport, Wallpaper};

pub struct Library {
    root: PathBuf,
    db: Db,
}

impl Library {
    /// `root` 为应用数据目录，库文件与缩略图都在其下。
    pub fn open(root: PathBuf) -> LibResult<Self> {
        std::fs::create_dir_all(&root)
            .map_err(|e| LibError::Io(format!("创建库目录失败：{e}")))?;
        let db = Db::open(&root.join("library.db"))?;
        Ok(Self { root, db })
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    /// 列出全部壁纸，按导入时间倒序。
    pub fn list(&self) -> LibResult<Vec<Wallpaper>> {
        Ok(self.db.list()?.into_iter().map(Wallpaper::from).collect())
    }

    /// 取单张壁纸的库内绝对路径。投放壁纸时用它。
    pub fn file_path_of(&self, id: &str) -> LibResult<Option<String>> {
        Ok(self.db.get(id)?.map(|r| r.file_path))
    }

    /// 批量导入文件或目录（目录会递归扫描）。
    ///
    /// `folder_id` 指定入库后归属的文件夹；`None` 表示放在库根目录。
    /// 导入到某个文件夹时，其子文件夹也会被递归扫描，但所有图片都归到该文件夹下，
    /// 不做「按源目录自动建子目录」——那会让用户的目录结构被意外复制进库。
    pub fn import(&self, paths: &[PathBuf], folder_id: Option<&str>) -> LibResult<ImportReport> {
        let mut report = ImportReport::default();

        // 目标文件夹必须存在，否则会写入悬挂引用
        if let Some(fid) = folder_id {
            if self.db.get_folder(fid)?.is_none() {
                return Err(LibError::Io("目标文件夹不存在".into()));
            }
        }

        for path in self.expand(paths) {
            match self.import_one(&path, folder_id) {
                Ok(true) => report.added += 1,
                Ok(false) => report.skipped += 1,
                Err(e) => report.failed.push(ImportFailure {
                    path: path.display().to_string(),
                    reason: e.to_string(),
                }),
            }
        }
        Ok(report)
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

    /// 导入单个文件。返回 `Ok(false)` 表示已存在而跳过。
    fn import_one(&self, source: &Path, folder_id: Option<&str>) -> LibResult<bool> {
        if !source.is_file() {
            return Err(LibError::NotFound(source.display().to_string()));
        }
        if !image_ops::is_supported(source) {
            return Err(LibError::Unsupported(source.display().to_string()));
        }

        // 规范化后的源路径用于去重，避免 ./a.jpg 与 a.jpg 被判为不同文件
        let canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
        let source_key = canonical.to_string_lossy().to_string();

        if self.db.find_by_source(&source_key)?.is_some() {
            return Ok(false);
        }

        // 已在本库目录内的文件不再复制，直接转码，避免自我复制
        let img = image_ops::load_oriented(&canonical)?;

        let id = uuid::Uuid::new_v4().simple().to_string();
        // 不带扩展名的基路径，实际扩展名由 normalize_for_wallpaper 依内容决定
        let file_base = image_ops::library_file_base(&self.root, &id);
        let thumb_path = image_ops::thumb_file_path(&self.root, &id);

        let (file_path, width, height) = image_ops::normalize_for_wallpaper(&img, &file_base)?;

        if let Some(parent) = thumb_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LibError::Io(format!("创建缩略图目录失败：{e}")))?;
        }
        let thumb_bytes = image_ops::make_thumbnail(&img)?;
        std::fs::write(&thumb_path, &thumb_bytes)
            .map_err(|e| LibError::Io(format!("写入缩略图失败：{e}")))?;

        let bytes = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

        let name = canonical
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into());

        self.db.insert(&WallpaperRecord {
            id,
            file_path: file_path.to_string_lossy().to_string(),
            thumb_path: thumb_path.to_string_lossy().to_string(),
            source_path: source_key,
            name,
            width,
            height,
            bytes,
            created_at: chrono_now(),
            folder_id: folder_id.map(|s| s.to_string()),
        })?;

        Ok(true)
    }

    /// 从库中移除。同时删除库内副本与缩略图，但**不碰**用户的原始文件。
    pub fn remove(&self, id: &str) -> LibResult<()> {
        if let Some(rec) = self.db.get(id)? {
            // 仅当路径确实位于库根目录内才删除，防止异常数据导致误删用户文件
            for p in [&rec.file_path, &rec.thumb_path] {
                let path = Path::new(p);
                if path.starts_with(&self.root) && path.exists() {
                    std::fs::remove_file(path).ok();
                }
            }
            // 兜底清理同基名的另一格式（png/jpg 切换时可能留下孤儿文件）
            let base = Path::new(&rec.file_path).with_extension("");
            for ext in ["png", "jpg"] {
                let alt = base.with_extension(ext);
                if alt.starts_with(&self.root) && alt.exists() {
                    std::fs::remove_file(alt).ok();
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
        let mut fixed = 0;
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
                if std::fs::write(thumb, bytes).is_ok() {
                    fixed += 1;
                }
            }
        }
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
                let key = std::fs::canonicalize(p)
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
        self.import(&[dir.to_path_buf()], folder_id)
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

/// 递归收集图片，`depth` 限制防止过深目录。
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
    use image::{Rgba, RgbaImage};

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("dwd-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_png(dir: &Path, name: &str) -> PathBuf {
        let img = RgbaImage::from_pixel(64, 40, Rgba([12, 200, 90, 255]));
        let p = dir.join(name);
        img.save(&p).unwrap();
        p
    }

    #[test]
    fn 导入后在库内生成副本且可列出() {
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

        // 库内副本存在，且不在源目录
        assert!(Path::new(&list[0].file_path).exists());
        assert!(Path::new(&list[0].thumb_path).exists());

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
    fn 删除只清理库内副本不动原始文件() {
        let root = temp_root("remove");
        let src = write_png(&root, "c.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&[src.clone()], None).unwrap();

        let wp = lib.list().unwrap().into_iter().next().unwrap();
        lib.remove(&wp.id).unwrap();

        assert!(lib.list().unwrap().is_empty());
        assert!(!Path::new(&wp.file_path).exists(), "库内副本应被删除");
        assert!(src.exists(), "用户原始文件必须保留");

        std::fs::remove_dir_all(&root).ok();
    }

    // ---------------- 文件夹 ----------------

    #[test]
    fn 缩略图丢失后可自动补齐() {
        let root = temp_root("thumb-repair");
        let src = write_png(&root, "e.png");
        let lib = Library::open(root.join("data")).unwrap();
        lib.import(&[src], None).unwrap();

        let wp = lib.list().unwrap().into_iter().next().unwrap();
        // 模拟「用户清理过库目录 / 拷贝时遗漏 thumbs」
        std::fs::remove_file(&wp.thumb_path).unwrap();
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
