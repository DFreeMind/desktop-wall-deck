//! 系统适配层：COM 封装 + 拓扑模型 + 显示器身份识别。

pub mod com;
pub mod error;
pub mod identity;
pub mod model;

pub use com::{Position, WallpaperWorker};
pub use model::{MonitorKind, Topology};
