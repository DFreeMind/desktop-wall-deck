//! 显示器拓扑模型。
//!
//! 这里的结构是前端「拓扑画布」的唯一数据来源，字段命名与前端 `Monitor` 类型一一对应。
//! 注意 `device_path` 是易失的（换端口会变），逻辑身份见 `mapping` 模块。

use serde::{Deserialize, Serialize};

/// 一块显示器在桌面坐标系中的位置与尺寸。
///
/// 由 `IDesktopWallpaper::GetMonitorRECT` 给出，坐标系原点在**主显示器左上角**，
/// 向右为 x 正方向、向下为 y 正方向，副屏可能落在负坐标。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    /// 是否为竖向（高度大于宽度）。竖屏的取景窗口与横屏完全不同，UI 需要区别对待。
    pub fn is_portrait(&self) -> bool {
        self.height() > self.width()
    }
}

/// 显示器来源分类。虚拟屏会污染列表，必须与真实物理屏区分。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MonitorKind {
    /// 物理显示器（有 EDID 信息）
    Physical,
    /// 虚拟显示适配器（串流、投屏、模拟器）
    Virtual,
    /// 无法判定来源
    Unknown,
}

/// 单台显示器的完整描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// COM 接口给出的设备路径，用于设置壁纸。
    /// 形如 `\\?\DISPLAY#LEN8AB1#4&3798061&0&UID8388688#{e6f07b5f-...}`
    pub device_path: String,

    /// 稳定的逻辑身份（EDID 派生）。设备路径变化时靠它重新绑定。
    pub identity: String,

    /// 人类可读名称，优先 EDID 型号，退化到设备路径片段。
    pub name: String,

    /// 厂商代码，如 LEN / DEL / PHLC。
    pub vendor: String,

    pub rect: Rect,

    pub kind: MonitorKind,

    /// 是否为主显示器（rect 原点所在屏）。
    pub primary: bool,

    /// 系统当前为该屏设置的壁纸绝对路径。
    ///
    /// 可能来自本应用以外的来源（用户手动设置、其他工具），
    /// 因此前端只在与库内记录匹配时才展示，否则显示占位色。
    pub current_wallpaper: Option<String>,
}

impl Monitor {
    /// 像素宽度，便于前端展示分辨率。
    pub fn width(&self) -> i32 {
        self.rect.width()
    }

    pub fn height(&self) -> i32 {
        self.rect.height()
    }
}

/// 当前桌面拓扑快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topology {
    pub monitors: Vec<Monitor>,
    /// 桌面虚拟坐标系的包围盒，前端按它等比缩放绘制画布。
    pub bounds: Rect,
}

impl Topology {
    /// 依据显示器列表计算包围盒。
    pub fn from_monitors(monitors: Vec<Monitor>) -> Self {
        let bounds = if monitors.is_empty() {
            Rect { left: 0, top: 0, right: 1, bottom: 1 }
        } else {
            let mut l = i32::MAX;
            let mut t = i32::MAX;
            let mut r = i32::MIN;
            let mut b = i32::MIN;
            for m in &monitors {
                l = l.min(m.rect.left);
                t = t.min(m.rect.top);
                r = r.max(m.rect.right);
                b = b.max(m.rect.bottom);
            }
            Rect { left: l, top: t, right: r, bottom: b }
        };
        Self { monitors, bounds }
    }
}
