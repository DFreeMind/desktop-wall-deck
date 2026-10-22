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

    pub fn open_library(root: PathBuf) -> Result<Library, String> {
        Library::open(root).map_err(|e| e.to_string())
    }

    pub fn list(lib: &Library) -> Result<Vec<Wallpaper>, String> {
        lib.list().map_err(|e| e.to_string())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_monitors,
            commands::apply_wallpaper,
            commands::apply_span,
            commands::library_list,
            commands::library_import,
            commands::library_remove,
            commands::library_rename,
            commands::library_usage,
            commands::fit_advice,
            commands::asset_url,
            commands::data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
