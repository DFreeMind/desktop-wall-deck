//! 端到端集成测试：真实图片 → 导入库 → 校验副本与缩略图 → 对比体积。
//!
//! 使用真实壁纸作为输入，比合成图片更能暴露格式兼容与体积问题。

use std::path::PathBuf;

use desktop_wall_deck_lib::test_api;

#[test]
fn 导入真实壁纸并生成缩略图() {
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

    let root = std::env::temp_dir().join(format!("dwd-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    let lib = test_api::open_library(root.clone()).unwrap();
    let report = lib.import(&samples, None).unwrap();

    println!(
        "导入结果：新增 {}，跳过 {}，失败 {}",
        report.added,
        report.skipped,
        report.failed.len()
    );
    for f in &report.failed {
        println!("  失败：{} -> {}", f.path, f.reason);
    }

    assert_eq!(report.failed.len(), 0, "样本图片不应导入失败");
    assert_eq!(report.added, samples.len());

    let mut total_copy: u64 = 0;

    for w in test_api::list(&lib).unwrap() {
        let fp = std::path::Path::new(&w.file_path);
        let tp = std::path::Path::new(&w.thumb_path);
        assert!(fp.exists(), "库内副本缺失：{}", w.file_path);
        assert!(tp.exists(), "缩略图缺失：{}", w.thumb_path);
        assert!(w.width > 0 && w.height > 0, "尺寸读取失败：{}", w.name);

        // 规范化后必须是 jpg 或 png：其他格式（webp/heic）在部分系统版本上
        // 设置为壁纸会变黑屏，必须转成 Windows 可靠支持的格式
        let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("");
        assert!(ext == "jpg" || ext == "png", "意外的存储格式：{ext}");

        total_copy += w.bytes;
        println!(
            "  ✓ {} {}x{} 副本 {:.2}MB ({})",
            w.name,
            w.width,
            w.height,
            w.bytes as f64 / 1048576.0,
            ext
        );
    }

    // 对照原始文件体积，确认规范化没有把库撑大
    let total_src: u64 = samples
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();

    println!(
        "体积对比：原始 {:.2}MB → 库内 {:.2}MB（{:.0}%）",
        total_src as f64 / 1048576.0,
        total_copy as f64 / 1048576.0,
        total_copy as f64 / total_src.max(1) as f64 * 100.0
    );

    // 硬性要求：库内副本总体不应超过原图的 1.3 倍。
    // 这条断言用于防止回归到「无损 PNG 存储」——那会让库体积接近翻倍。
    assert!(
        total_copy as f64 <= total_src as f64 * 1.3,
        "库内副本体积超出预期，可能退回了无损存储"
    );

    let _ = std::fs::remove_dir_all(&root);
}
