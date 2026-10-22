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
use super::model::{ImportFailure, ImportReport, Wallpaper};

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
    pub fn import(&self, paths: &[PathBuf]) -> LibResult<ImportReport> {
        let mut report = ImportReport::default();

        for path in self.expand(paths) {
            match self.import_one(&path) {
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
    fn import_one(&self, source: &Path) -> LibResult<bool> {
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
        let report = lib.import(&[src.clone()]).unwrap();
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

        assert_eq!(lib.import(&[src.clone()]).unwrap().added, 1);
        let second = lib.import(&[src]).unwrap();
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
        lib.import(&[src.clone()]).unwrap();

        let wp = lib.list().unwrap().into_iter().next().unwrap();
        lib.remove(&wp.id).unwrap();

        assert!(lib.list().unwrap().is_empty());
        assert!(!Path::new(&wp.file_path).exists(), "库内副本应被删除");
        assert!(src.exists(), "用户原始文件必须保留");

        std::fs::remove_dir_all(&root).ok();
    }
}
