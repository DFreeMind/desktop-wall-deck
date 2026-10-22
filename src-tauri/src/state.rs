//! 应用全局状态。
//!
//! 只持有可能被多个命令共享的组件。COM worker 内部自带线程与 channel，
//! `Clone` 廉价，因此直接持有即可。

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::library::Library;
use crate::wallpaper::{Topology, WallpaperWorker};

pub struct AppState {
    pub worker: WallpaperWorker,
    pub library: Arc<Library>,
    pub data_dir: PathBuf,

    /// 最近一次枚举的拓扑。缓存它有两个用途：
    /// 1. 前端布局切换时无需重复走 COM
    /// 2. 拓扑变化事件里可以对比新旧列表，判断是否需要重放绑定
    pub topology: RwLock<Option<Topology>>,
}

impl AppState {
    pub fn new(worker: WallpaperWorker, library: Library, data_dir: PathBuf) -> Self {
        Self {
            worker,
            library: Arc::new(library),
            data_dir,
            topology: RwLock::new(None),
        }
    }

    pub fn cached_topology(&self) -> Option<Topology> {
        self.topology.read().clone()
    }

    pub fn store_topology(&self, t: Topology) {
        *self.topology.write() = Some(t);
    }
}
