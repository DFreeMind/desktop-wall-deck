//! 桌面壁纸管理应用 —— 库入口。

mod commands;
mod display_watch;
mod library;
mod state;
mod topology_watch;
mod wallpaper;

/// 集成测试用入口。
///
/// 只暴露 `Library::open` 这一条路径，供 `tests/` 下的端到端测试验证
/// 「真实图片 → 转码 → 入库 → 生成缩略图」的完整链路。
/// 生产代码不走这里，模块本身仍保持私有，避免外部误用内部实现。
#[doc(hidden)]
pub mod test_api {
    use std::path::PathBuf;

    pub use crate::library::model::Wallpaper;
    pub use crate::library::Library;
    pub use crate::wallpaper::com::{Position, RawMonitor, WallpaperWorker};

    pub fn open_library(root: PathBuf) -> Result<Library, String> {
        Library::open(root).map_err(|e| e.to_string())
    }

    pub fn list(lib: &Library) -> Result<Vec<Wallpaper>, String> {
        lib.list().map_err(|e| e.to_string())
    }

    /// 构造壁纸工作线程，用于真实投放验证。
    pub fn new_worker() -> WallpaperWorker {
        WallpaperWorker::spawn()
    }

    pub fn position_fill() -> Position {
        Position::Fill
    }

    /// 枚举显示器原始数据（含当前壁纸路径）。
    pub fn list_monitors(worker: &WallpaperWorker) -> Result<Vec<RawMonitor>, String> {
        worker.list_monitors().map_err(|e| e.to_string())
    }

    /// 设置壁纸，`monitor_id` 为 None 表示全部屏幕。
    pub fn set_wallpaper(
        worker: &WallpaperWorker,
        monitor_id: Option<String>,
        path: &str,
        position: Position,
    ) -> Result<(), String> {
        worker.set_wallpaper(monitor_id, path, position).map_err(|e| e.to_string())
    }
}

use tauri::Manager;

use library::Library;
use state::AppState;
use wallpaper::WallpaperWorker;

/// 应用数据目录：`%APPDATA%/com.duqimeng.desktopwalldeck`。
///
/// 壁纸副本、缩略图、SQLite 库都在这里，便于用户整体备份或迁移。
fn resolve_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            std::fs::create_dir_all(&data_dir).ok();

            let worker = WallpaperWorker::spawn();
            let library = Library::open(data_dir.clone())
                .map_err(|e| format!("初始化壁纸库失败：{e}"))?;

            let state = AppState::new(worker.clone(), library, data_dir.clone());

            // 缩略图是派生文件，可能因目录被清理或拷贝时遗漏而缺失，
            // 表现为列表一片灰块。原图还在，启动后顺手补齐，不打扰用户。
            state.library.repair_thumbnails().ok();

            // 拓扑变化 → 重放绑定的处理线程
            // 注意：worker 是 Clone 语义（内部共享 channel），传克隆值避免所有权移动
            let tx = topology_watch::spawn(worker.clone(), state.library.clone());
            // 系统显示配置变化的来源
            display_watch::spawn_listener(tx);

            // 启动时预热一次拓扑，让前端首屏不用等待 COM 冷启动
            if let Ok(raw) = worker.list_monitors() {
                let topology = wallpaper::Topology::from_monitors(
                    wallpaper::identity::build_monitors(raw),
                );
                state.store_topology(topology);
            }

            app.manage(state);

            // —— 诊断：确认 WebView 是否真的加载了内嵌前端资源 ——
            // 仅在设置 DW_DEBUG_WEBVIEW=1 时输出，避免污染正常日志。
            if std::env::var("DW_DEBUG_WEBVIEW").is_ok() {
                use tauri::Manager as _;
                if let Some(win) = app.get_webview_window("main") {
                    eprintln!("[diag] 窗口存在: {}", win.label());
                    eprintln!("[diag] 当前 URL: {:?}", win.url());
                    let w2 = win.clone();
                    std::thread::spawn(move || {
                        for i in 0..8 {
                            std::thread::sleep(std::time::Duration::from_millis(800));
                            let url = w2.url().map(|u| u.to_string()).unwrap_or_default();
                            eprintln!("[diag] t={}ms url={}", (i + 1) * 800, url);
                            if url.starts_with("http") && !url.contains("localhost:1420") {
                                break;
                            }
                        }
                    });
                } else {
                    eprintln!("[diag] 拿不到 main 窗口");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_monitors,
            commands::apply_wallpaper,
            commands::apply_span,
            commands::library_list,
            commands::library_list_in_folder,
            commands::library_import,
            commands::library_remove,
            commands::library_rename,
            commands::library_usage,
            commands::library_move_to_folder,
            commands::library_scan_folder,
            commands::library_import_folder,
            commands::library_repair_thumbnails,
            commands::current_wallpaper_preview,
            commands::folder_create,
            commands::folder_rename,
            commands::folder_delete,
            commands::folder_tree,
            commands::fit_advice,
            commands::asset_url,
            commands::data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
