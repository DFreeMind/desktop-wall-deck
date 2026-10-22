//! 壁纸相关错误类型。
//!
//! 约定：所有面向用户的错误信息使用中文，底层 HRESULT 以十六进制保留在消息中便于排查。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WallpaperError {
    #[error("初始化 COM 失败：0x{0:08X}")]
    ComInit(u32),

    #[error("无法创建 IDesktopWallpaper 实例（0x{0:08X}）")]
    CreateInstance(u32),

    #[error("Windows 壁纸接口调用失败：{operation} 返回 0x{code:08X}")]
    Com { operation: &'static str, code: u32 },

    #[error("设置壁纸失败：{0}")]
    SetFailed(String),

    #[error("壁纸工作线程已停止")]
    WorkerStopped,

    #[error("壁纸工作线程响应超时")]
    WorkerTimeout,
}

pub type WpResult<T> = Result<T, WallpaperError>;

#[cfg(windows)]
impl WallpaperError {
    pub fn com(operation: &'static str, err: &windows::core::Error) -> Self {
        // windows crate 的 Error 携带 HRESULT，取 u32 保留原始码。
        WallpaperError::Com {
            operation,
            code: err.code().0 as u32,
        }
    }
}
