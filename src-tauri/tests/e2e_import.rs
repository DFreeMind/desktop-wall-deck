//! 端到端集成测试：真实图片只索引原文件，缩略图与规范化投放缓存按需生成。
//!
//! 使用真实壁纸作为输入，检查源文件未被改写，并对显式投放准备后的格式与体积做回归校验。

use std::path::{Path, PathBuf};

use desktop_wall_deck_lib::test_api;

fn normalized_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let without_prefix = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| raw.into_owned());
    without_prefix.replace('/', "\\").to_lowercase()
}

#[test]
fn 导入真实壁纸只索引并在修复和投放准备后生成派生文件() {
    let src_dir = PathBuf::from(r"C:/Users/qiulu/Desktop/imgs/壁纸");
    let mut samples: Vec<PathBuf> = Vec::new();
    if src_dir.is_dir() {
        for e in std::fs::read_dir(&src_dir).unwrap().flatten() {
            let p = e.path();
            if p.is_file()
                && matches!(
                    p.extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.to_ascii_lowercase())
                        .as_deref(),
                    Some("png") | Some("jpg") | Some("jpeg")
                )
            {
                samples.push(p);
                if samples.len() >= 3 {
                    break;
                }
            }
        }
    }

    if samples.is_empty() {
        eprintln!("跳过：未找到样本图片");
        return;
    }

    let original_bytes: Vec<Vec<u8>> = samples
        .iter()
        .map(|path| std::fs::read(path).unwrap())
        .collect();
    let root = std::env::temp_dir().join(format!("dwd-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    let lib = test_api::open_library(root.clone()).unwrap();
    let report = lib.import(&samples, None).unwrap();
    assert_eq!(report.failed.len(), 0, "样本图片不应导入失败");
    assert_eq!(report.added, samples.len());

    let indexed = test_api::list(&lib).unwrap();
    assert_eq!(indexed.len(), samples.len());
    assert!(indexed.iter().all(|w| w.storage_kind == "indexed"));
    assert!(indexed.iter().all(|w| !Path::new(&w.thumb_path).exists()));
    assert!(!root.join("files").exists(), "索引导入不创建原图副本目录");
    assert!(!root.join("rendered").exists(), "导入时不创建投放缓存");
    for wallpaper in &indexed {
        let indexed_path = Path::new(&wallpaper.file_path);
        let sample_index = samples
            .iter()
            .position(|sample| normalized_path(sample) == normalized_path(indexed_path))
            .expect("列表路径必须对应一个导入样本");
        assert_eq!(
            &std::fs::read(&samples[sample_index]).unwrap(),
            &original_bytes[sample_index],
            "源文件字节不能被改写"
        );
        assert!(wallpaper.width > 0 && wallpaper.height > 0, "尺寸读取失败：{}", wallpaper.name);
    }

    assert_eq!(lib.repair_thumbnails().unwrap(), samples.len());
    let repaired = test_api::list(&lib).unwrap();
    assert!(repaired.iter().all(|w| Path::new(&w.thumb_path).is_file()));

    let mut total_rendered = 0_u64;
    for wallpaper in &repaired {
        let rendered = lib.prepare_wallpaper(&wallpaper.id).unwrap();
        let path = Path::new(&rendered);
        assert!(path.is_file(), "投放缓存缺失：{rendered}");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        assert!(ext == "jpg" || ext == "png", "意外的规范化格式：{ext}");
        total_rendered += path.metadata().unwrap().len();
    }

    let total_source: u64 = original_bytes.iter().map(|bytes| bytes.len() as u64).sum();
    println!(
        "索引 {} 张；源文件 {:.2}MB → 显式生成的投放缓存 {:.2}MB",
        samples.len(),
        total_source as f64 / 1048576.0,
        total_rendered as f64 / 1048576.0,
    );
    assert!(
        total_rendered as f64 <= total_source as f64 * 1.3,
        "JPEG92 规范化后的总体积超出预期"
    );

    let _ = std::fs::remove_dir_all(&root);
}
