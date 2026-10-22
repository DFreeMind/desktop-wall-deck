//! 壁纸库对外数据模型。字段与前端 TypeScript 类型严格对应。

use serde::{Deserialize, Serialize};

/// 一张入库的壁纸。
///
/// `filePath` 是库内规范化副本（PNG）的绝对路径，`thumbPath` 是缩略图。
/// 两者都由后端生成，前端只用于展示，不参与拼接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wallpaper {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub thumb_path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub created_at: i64,
}

/// 某台显示器当前的壁纸绑定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorBinding {
    /// 显示器逻辑身份（EDID 派生），不是易变的 device path
    pub identity: String,
    pub wallpaper_id: Option<String>,
    /// fill / fit / stretch / center / tile
    pub position: String,
}

/// 导入结果汇总。导入是批量操作，需要逐条反馈成功与失败原因。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub skipped: usize,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub reason: String,
}
