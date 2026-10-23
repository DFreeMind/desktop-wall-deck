//! 系统壁纸预览的磁盘缓存。命中时仅检查源文件元数据，无需再次解码大图。
use crate::library::image_ops;
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::Path,
    time::UNIX_EPOCH,
};

#[derive(Serialize, Deserialize)]
struct CachedPreview {
    path: String,
    bytes: u64,
    modified: u128,
    data_url: String,
}

pub fn load(path: &Path, cache_dir: &Path) -> Result<String, String> {
    let metadata = path
        .metadata()
        .map_err(|e| format!("读取壁纸文件失败：{e}"))?;
    if !metadata.is_file() {
        return Err("壁纸文件不存在".into());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos());
    let name = path.to_string_lossy().to_string();
    let mut hash = DefaultHasher::new();
    name.hash(&mut hash);
    let cache_file = cache_dir.join(format!("{:016x}.json", hash.finish()));
    if let Some(modified) = modified {
        if let Ok(bytes) = std::fs::read(&cache_file) {
            if let Ok(cached) = serde_json::from_slice::<CachedPreview>(&bytes) {
                if cached.path == name
                    && cached.bytes == metadata.len()
                    && cached.modified == modified
                    && cached.data_url.starts_with("data:image/png;base64,")
                {
                    return Ok(cached.data_url);
                }
            }
        }
    }
    let data_url = image_ops::make_preview_data_url(path).map_err(|e| e.to_string())?;
    // 缓存不可写不影响预览；元数据无法可靠读取时不缓存。
    if let Some(modified) = modified {
        let cached = CachedPreview {
            path: name,
            bytes: metadata.len(),
            modified,
            data_url: data_url.clone(),
        };
        if std::fs::create_dir_all(cache_dir).is_ok() {
            if let Ok(bytes) = serde_json::to_vec(&cached) {
                let _ = std::fs::write(&cache_file, bytes);
            }
            prune(cache_dir);
        }
    }
    Ok(data_url)
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|e| {
            e.metadata()
                .ok()
                .filter(|m| m.is_file())
                .map(|m| (e.path(), m.modified().ok()))
        })
        .collect();
    files.sort_by_key(|(_, modified)| *modified);
    let excess = files.len().saturating_sub(128);
    for (path, _) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "只读指定的本地样本；设置 DWD_PERF_IMAGE 后手动运行"]
    fn 本地壁纸预览冷暖缓存耗时() {
        let source = std::path::PathBuf::from(
            std::env::var("DWD_PERF_IMAGE").expect("请设置 DWD_PERF_IMAGE"),
        );
        let cache = std::env::temp_dir().join(format!("preview-perf-{}", uuid::Uuid::new_v4()));
        let start = std::time::Instant::now();
        let cold = load(&source, &cache).unwrap();
        let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        for _ in 0..10 {
            assert_eq!(load(&source, &cache).unwrap(), cold);
        }
        let warm_ms = start.elapsed().as_secs_f64() * 100.0;
        println!(
            "首次解码缓存：{cold_ms:.2}ms；缓存命中平均：{warm_ms:.2}ms；预览字节数：{}",
            cold.len()
        );
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[test]
    fn 预览缓存命中且源文件改变或缓存损坏时重建() {
        let root = std::env::temp_dir().join(format!("preview-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let cache = root.join("cache");
        image::RgbImage::from_pixel(20, 10, image::Rgb([20, 40, 60]))
            .save(&source)
            .unwrap();
        let first = load(&source, &cache).unwrap();
        let cached = std::fs::read_dir(&cache)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let stamp = cached.metadata().unwrap().modified().unwrap();
        assert_eq!(load(&source, &cache).unwrap(), first);
        assert_eq!(cached.metadata().unwrap().modified().unwrap(), stamp);
        image::RgbImage::from_pixel(40, 30, image::Rgb([250, 80, 0]))
            .save(&source)
            .unwrap();
        let changed = load(&source, &cache).unwrap();
        assert_ne!(changed, first);
        std::fs::write(&cached, "损坏的缓存").unwrap();
        assert_eq!(load(&source, &cache).unwrap(), changed);
        std::fs::remove_file(&source).unwrap();
        assert!(load(&source, &cache).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
