//! `IDesktopWallpaper` COM 调用封装。
//!
//! # 线程模型
//!
//! `IDesktopWallpaper` 是 STA 对象，接口指针既不能跨线程传递，也不能多线程并发调用。
//! 本模块因此把所有 COM 调用收敛到 `WallpaperWorker` 这个**独占线程**里：
//! 主线程通过 channel 发送 `Cmd`，worker 线程内串行执行并回传结果。
//! 这样上层（commands / 调度器）可以自由从任意线程调用，而 COM 的线程约束被结构性保证。
//!
//! 不在同一个线程里复用实例的原因：显示器热插拔会改变 `GetMonitorDevicePathCount`，
//! 但接口实例本身可继续使用；真正需要重建实例的场景（COM 单元被重置）极少，
//! 因此 worker 内部按需懒创建，失败则报错而非静默重试。

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use super::error::{WpResult, WallpaperError};
use super::model::Rect;

/// 单次请求的等待上限。设置壁纸是毫秒级操作，超过这个时间说明 COM 侧卡死。
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// 壁纸填充方式，与 `DESKTOP_WALLPAPER_POSITION` 枚举值一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Position {
    /// 居中，不缩放
    Center,
    /// 平铺
    Tile,
    /// 拉伸铺满（不保持比例）
    Stretch,
    /// 适应，完整显示并留边
    Fit,
    /// 填充，保持比例裁剪铺满（默认推荐）
    Fill,
    /// 跨屏，仅在连续矩形排布下正确，本项目不使用，保留仅为兼容枚举值
    Span,
}

impl Position {
    pub fn to_raw(self) -> i32 {
        match self {
            Position::Center => 0,
            Position::Tile => 1,
            Position::Stretch => 2,
            Position::Fit => 3,
            Position::Fill => 4,
            Position::Span => 5,
        }
    }

}

/// 显示器原始信息，未经 EDID 解析。
#[derive(Debug, Clone)]
pub struct RawMonitor {
    pub device_path: String,
    pub rect: Rect,
    pub wallpaper: Option<String>,
}

enum Cmd {
    ListMonitors(Sender<WpResult<Vec<RawMonitor>>>),
    SetWallpaper {
        monitor_id: Option<String>,
        path: String,
        position: Position,
        reply: Sender<WpResult<()>>,
    },
}

/// 壁纸操作的工作线程句柄。`Clone` 是廉价的，内部只共享 channel 发送端。
#[derive(Clone)]
pub struct WallpaperWorker {
    tx: Sender<Cmd>,
}

impl WallpaperWorker {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();

        thread::Builder::new()
            .name("wallpaper-com".into())
            .spawn(move || {
                // 在专属线程内初始化 COM（STA），此后本线程不再做别的事。
                let ctx = match platform::open() {
                    Ok(ctx) => ctx,
                    Err(err) => {
                        // COM 初始化失败时仍要持续消费请求，否则调用方会永久阻塞，
                        // 改为把错误原样回传给每个请求。
                        let err_msg = err.to_string();
                        for cmd in rx {
                            platform::reply_init_failure(cmd, &err_msg);
                        }
                        return;
                    }
                };

                for cmd in rx {
                    platform::handle(&ctx, cmd);
                }
                platform::close(&ctx);
            })
            .expect("无法创建壁纸工作线程");

        Self { tx }
    }

    fn call<T>(&self, build: impl FnOnce(Sender<WpResult<T>>) -> Cmd) -> WpResult<T> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| WallpaperError::WorkerStopped)?;
        match reply_rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(WallpaperError::WorkerTimeout),
            Err(RecvTimeoutError::Disconnected) => Err(WallpaperError::WorkerStopped),
        }
    }

    /// 枚举当前所有显示器及其已设置的壁纸路径。
    pub fn list_monitors(&self) -> WpResult<Vec<RawMonitor>> {
        self.call(Cmd::ListMonitors)
    }

    /// 设置壁纸。
    ///
    /// `monitor_id` 为 `None` 时调用 `SetWallpaper(NULL, ...)`，语义是**所有显示器统一壁纸**。
    /// 这样新插入的显示器也会继承同一张图，比循环逐屏设置更符合系统预期。
    pub fn set_wallpaper(
        &self,
        monitor_id: Option<String>,
        path: &str,
        position: Position,
    ) -> WpResult<()> {
        if !std::path::Path::new(path).is_absolute() {
            return Err(WallpaperError::SetFailed(format!(
                "壁纸路径必须是绝对路径：{path}"
            )));
        }
        self.call(|reply| Cmd::SetWallpaper {
            monitor_id,
            path: path.to_string(),
            position,
            reply,
        })
    }

}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};

    pub struct ComCtx {
        wallpaper: IDesktopWallpaper,
    }

    /// 把 COM 返回的 PWSTR 转为 String。
    ///
    /// 接口是 `GetMonitorDevicePathAt(i, *mut PWSTR)` 风格（由 `[out] LPWSTR` 生成），
    /// 取到的指针由 CoTaskMem 分配，需要读完即释放，避免枚举时泄漏。
    unsafe fn take_pwstr(ptr: windows::core::PWSTR) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let s = ptr.to_string().unwrap_or_default();
        windows::Win32::System::Com::CoTaskMemFree(Some(ptr.0 as *const core::ffi::c_void));
        s
    }

    pub fn open() -> WpResult<ComCtx> {
        // SAFETY: 本函数只在 worker 专属线程调用一次，且线程此后不再做其他 COM 操作。
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| WallpaperError::ComInit(e.code().0 as u32))?;

            let wallpaper: IDesktopWallpaper =
                CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)
                    .map_err(|e| WallpaperError::CreateInstance(e.code().0 as u32))?;

            Ok(ComCtx { wallpaper })
        }
    }

    pub fn close(_ctx: &ComCtx) {
        // 先让接口在 drop 时于同线程释放，再反初始化单元。
        unsafe { CoUninitialize() };
    }

    pub fn reply_init_failure(cmd: Cmd, msg: &str) {
        let err = || WallpaperError::SetFailed(msg.to_string());
        match cmd {
            Cmd::ListMonitors(tx) => {
                let _ = tx.send(Err(err()));
            }
            Cmd::SetWallpaper { reply, .. } => {
                let _ = reply.send(Err(err()));
            }
        }
    }

    pub fn handle(ctx: &ComCtx, cmd: Cmd) {
        let w = &ctx.wallpaper;
        match cmd {
            Cmd::ListMonitors(tx) => {
                let _ = tx.send(unsafe { list_monitors(w) });
            }
            Cmd::SetWallpaper { monitor_id, path, position, reply } => {
                let _ = reply.send(unsafe { apply(w, monitor_id.as_deref(), &path, position) });
            }
        }
    }

    unsafe fn list_monitors(w: &IDesktopWallpaper) -> WpResult<Vec<RawMonitor>> {
        let count = w
            .GetMonitorDevicePathCount()
            .map_err(|e| WallpaperError::com("GetMonitorDevicePathCount", &e))?;

        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let device_path = match w.GetMonitorDevicePathAt(i) {
                Ok(ptr) => take_pwstr(ptr),
                Err(_) => continue, // 单台设备读取失败不应中断整体枚举
            };
            if device_path.is_empty() {
                continue;
            }

            // 宽字符串需在调用期间保持存活，因此缓存到本地 Vec 复用。
            let device_w: Vec<u16> = device_path
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let id_pc = PCWSTR::from_raw(device_w.as_ptr());

            let rect = match w.GetMonitorRECT(id_pc) {
                Ok(r) => Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                Err(_) => continue,
            };

            let wallpaper = w
                .GetWallpaper(id_pc)
                .map(|p| take_pwstr(p))
                .ok()
                .filter(|s| !s.is_empty());

            out.push(RawMonitor { device_path, rect, wallpaper });
        }
        Ok(out)
    }

    unsafe fn apply(
        w: &IDesktopWallpaper,
        monitor_id: Option<&str>,
        path: &str,
        position: Position,
    ) -> WpResult<()> {
        // 填充方式必须在设置壁纸前写入，否则新图会短暂按旧模式渲染一帧。
        w.SetPosition(windows::Win32::UI::Shell::DESKTOP_WALLPAPER_POSITION(position.to_raw()))
            .map_err(|e| WallpaperError::com("SetPosition", &e))?;

        let path_w: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let path_pc = PCWSTR::from_raw(path_w.as_ptr());

        match monitor_id {
            // NULL 表示对所有显示器统一设置
            None => w
                .SetWallpaper(PCWSTR::null(), path_pc)
                .map_err(|e| WallpaperError::com("SetWallpaper(all)", &e)),
            Some(id) => {
                let id_w: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                w.SetWallpaper(PCWSTR::from_raw(id_w.as_ptr()), path_pc)
                    .map_err(|e| WallpaperError::com("SetWallpaper", &e))
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub struct ComCtx;

    pub fn open() -> WpResult<ComCtx> {
        Err(WallpaperError::SetFailed("仅支持 Windows 系统".into()))
    }
    pub fn close(_c: &ComCtx) {}
    pub fn reply_init_failure(cmd: Cmd, msg: &str) {
        reply_init_failure_stub(cmd, msg)
    }
    pub fn handle(_c: &ComCtx, _cmd: Cmd) {}

    fn reply_init_failure_stub(cmd: Cmd, msg: &str) {
        let err = || WallpaperError::SetFailed(msg.to_string());
        match cmd {
            Cmd::ListMonitors(tx) => {
                let _ = tx.send(Err(err()));
            }
            Cmd::SetWallpaper { reply, .. } => {
                let _ = reply.send(Err(err()));
            }
        }
    }
}
