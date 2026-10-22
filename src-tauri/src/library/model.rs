//! 壁纸库对外数据模型。字段与前端 TypeScript 类型严格对应。

use serde::{Deserialize, Serialize};

/// 一张入库的壁纸。
///
/// `filePath` 是库内规范化副本的绝对路径，`thumbPath` 是缩略图。
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
    /// 所属文件夹；`None` 表示位于库根目录（未归入任何文件夹）
    pub folder_id: Option<String>,
}

/// 壁纸文件夹。
///
/// 采用单层父子关系（`parent_id` 自引用），支持任意深度嵌套。
/// 这里不做「智能文件夹」或标签体系——壁纸整理的真实需求是「分场景归类」，
/// 目录树比标签更符合直觉，也不需要用户先建立一套分类学。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// 父文件夹；`None` 表示顶层文件夹
    pub parent_id: Option<String>,
    pub created_at: i64,
}

/// 带统计信息的文件夹节点，供前端渲染侧边目录树。
///
/// `direct_count` 与 `total_count` 分开给出：前者是文件夹内直接存放的张数，
/// 后者含所有子文件夹。UI 上显示总数，但用直接数量判断「是否为空文件夹」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    #[serde(flatten)]
    pub folder: Folder,
    pub direct_count: usize,
    pub total_count: usize,
    /// 子文件夹 id 列表，前端据此构建树
    pub children: Vec<String>,
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
