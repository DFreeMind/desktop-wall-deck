//! 壁纸库：导入、转码、索引、查询。

pub mod db;
pub mod error;
pub mod image_ops;
pub mod model;
pub mod service;

pub use model::{CacheCleanupReport, Folder, FolderNode, FolderScan, ImportReport, MonitorBinding, Wallpaper, WallpaperDetails};
pub use service::Library;
