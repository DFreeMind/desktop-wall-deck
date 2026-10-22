//! 显示器拓扑变化监听。
//!
//! # 要解决的问题
//!
//! Windows 在显示器断开（拔线、关闭外接屏、切换远程桌面）时会重新分配显示配置，
//! 常见后果是所有屏幕的壁纸被重置成同一张，或者动画壁纸顺序错乱。
//! 这是多显示器壁纸工具必须处理的现实问题。
//!
//! # 处理方式
//!
//! 监听 `WM_DISPLAYCHANGE` 后，延迟 1.5 秒（等待系统把配置写完）再重新枚举，
//! 并按持久化的逻辑身份绑定关系重放一次。延迟是必要的：立刻读取往往拿到中间态。
//!
//! 防抖同样必要：一次插拔会连发多个事件，若不去重会重复设置壁纸造成闪烁。

use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, Sender};

use crate::library::MonitorBinding;
use crate::wallpaper::identity::build_monitors;
use crate::wallpaper::{Position, Topology};

/// 拓扑变化后的等待时间，让系统完成显示配置落盘。
const SETTLE_DELAY: Duration = Duration::from_millis(1500);

/// 起一个常驻线程处理拓扑变化事件，返回事件发送端。
///
/// 平台监听器（如 Windows 的 WM_DISPLAYCHANGE 钩子）拿到通知后投递到该 channel 即可，
/// 所有重逻辑都在本线程内串行完成，避免阻塞 UI 或消息循环。
pub fn spawn(worker: crate::wallpaper::WallpaperWorker, library: std::sync::Arc<crate::library::Library>) -> Sender<()> {
    // 容量 1：连续事件在 channel 里合并，天然实现防抖的「只保留最后一次」
    let (tx, rx): (Sender<()>, Receiver<()>) = bounded(1);

    thread::Builder::new()
        .name("topology-watch".into())
        .spawn(move || loop {
            // 阻塞等待首个事件
            if rx.recv().is_err() {
                return;
            }
            // 排空紧随其后的重复事件
            while rx.try_recv().is_ok() {}
            thread::sleep(SETTLE_DELAY);

            if let Err(e) = restore(&worker, &library) {
                eprintln!("[拓扑恢复] 失败：{e}");
            }
        })
        .expect("无法创建拓扑监视线程");

    tx
}

/// 重新枚举显示器，并按绑定关系恢复壁纸。
fn restore(
    worker: &crate::wallpaper::WallpaperWorker,
    library: &crate::library::Library,
) -> Result<(), String> {
    let raw = worker.list_monitors().map_err(|e| e.to_string())?;
    let monitors = build_monitors(raw);
    let topology = Topology::from_monitors(monitors);

    let bindings = library.db().load_bindings().map_err(|e| e.to_string())?;
    apply_bindings(worker, library, &topology, &bindings)
}

/// 按绑定关系把壁纸重新投放到当前在线的显示器上。
///
/// 只处理「当前在线且身份匹配」的组合；身份对不上的屏保持系统现状，
/// 而不是套用别人的壁纸——错误套用比不恢复更让人困惑。
pub fn apply_bindings(
    worker: &crate::wallpaper::WallpaperWorker,
    library: &crate::library::Library,
    topology: &Topology,
    bindings: &[MonitorBinding],
) -> Result<(), String> {
    for monitor in &topology.monitors {
        let Some(binding) = bindings.iter().find(|b| b.identity == monitor.identity) else {
            continue;
        };
        let Some(wallpaper_id) = &binding.wallpaper_id else {
            continue;
        };
        let Some(path) = library.file_path_of(wallpaper_id).map_err(|e| e.to_string())? else {
            continue;
        };
        let position = match binding.position.as_str() {
            "center" => Position::Center,
            "tile" => Position::Tile,
            "stretch" => Position::Stretch,
            "fit" => Position::Fit,
            _ => Position::Fill,
        };
        worker
            .set_wallpaper(Some(monitor.device_path.clone()), &path, position)
            .map_err(|e| format!("恢复「{}」失败：{e}", monitor.name))?;
    }
    Ok(())
}
