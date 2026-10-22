//! 真实壁纸投放验证：把一张图写到指定显示器，回读确认，再恢复原状。
//!
//! 这个测试会真实修改桌面壁纸，因此必须保证：
//! 1. 先记录原壁纸路径
//! 2. 无论断言是否失败，最后都恢复
//! 3. 只操作索引 0 的一块屏，不波及其他屏幕

use desktop_wall_deck_lib::test_api;

#[test]
fn 设置壁纸后回读一致并恢复原状() {
    let root = std::env::temp_dir().join(format!("dwd-apply-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);

    let lib = test_api::open_library(root.clone()).unwrap();

    // 取一张真实图片导入
    let src = std::path::PathBuf::from(r"C:/Users/qiulu/Desktop/imgs/壁纸/1129057.jpg");
    if !src.exists() {
        eprintln!("跳过：样本图片不存在");
        return;
    }
    let report = lib.import(&[src]).unwrap();
    assert_eq!(report.added, 1);
    let wp = test_api::list(&lib).unwrap().into_iter().next().unwrap();

    let worker = test_api::new_worker();
    let before = test_api::list_monitors(&worker).expect("枚举显示器失败");
    assert!(!before.is_empty(), "至少应有一块显示器");

    let target = &before[0];
    let original = target.wallpaper.clone();
    println!("目标显示器：{}", target.device_path);
    println!("原壁纸：{:?}", original);
    println!("新壁纸：{}", wp.file_path);

    // 设置为填充模式并投放
    let applied = test_api::set_wallpaper(
        &worker,
        Some(target.device_path.clone()),
        &wp.file_path,
        test_api::position_fill(),
    );
    println!("投放结果：{applied:?}");

    // 回读确认系统确实接受了变更
    let after = test_api::list_monitors(&worker).unwrap();
    let current = after
        .iter()
        .find(|m| m.device_path == target.device_path)
        .and_then(|m| m.wallpaper.clone());

    println!("回读壁纸：{:?}", current);
    let ok = current
        .as_ref()
        .map(|c| {
            c.to_lowercase().replace('/', "\\") == wp.file_path.to_lowercase().replace('/', "\\")
        })
        .unwrap_or(false);

    // 无论成败都恢复原壁纸
    if let Some(orig) = &original {
        let restored = test_api::set_wallpaper(
            &worker,
            Some(target.device_path.clone()),
            orig,
            test_api::position_fill(),
        );
        println!("恢复原壁纸：{restored:?}");
    }

    let _ = std::fs::remove_dir_all(&root);
    assert!(applied.is_ok(), "设置壁纸应成功：{applied:?}");
    assert!(ok, "回读路径应与设置的一致");
}
