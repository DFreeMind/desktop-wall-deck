//! 壁纸库对外数据模型。字段与前端 TypeScript 类型严格对应。

use serde::{Deserialize, Serialize};

/// 一张入库的壁纸。
///
/// 本机图片 filePath 指向原文件；下载和旧版图片仍指向应用副本。
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
    pub storage_kind: String,
    pub missing: bool,
    pub cached_path: Option<String>,
}

/// 壁纸文件详情；`indexed_at` 是入库时间，文件创建/修改时间来自原文件系统元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperDetails {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub parent_path: String,
    pub extension: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub indexed_at: i64,
    pub file_created_at: Option<i64>,
    pub file_modified_at: Option<i64>,
    pub exists: bool,
    pub storage_kind: String,
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
    /// 跨屏分片的持久化路径；普通壁纸为 None，恢复时不能把原图当分片投放。
    #[serde(default)]
    pub rendered_path: Option<String>,
}

/// 导入结果汇总。导入是批量操作，需要逐条反馈成功与失败原因。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub path: String,
    pub reason: String,
}

/// 目录预扫描结果。
///
/// `total` 是扫描到的图片总数（含已在库中的），`already_in_library` 是其中
/// 因源路径已存在而会被跳过的数量。两者之差就是「导入后新增多少」，
/// 用于在用户确认前把结果说清楚。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub path: String,
    pub total: usize,
    pub already_in_library: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFolder {
    pub id: String,
    pub path: String,
    pub folder_id: Option<String>,
    pub available: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStorage {
    pub count: usize,
    pub indexed_bytes: u64,
    pub managed_bytes: u64,
    pub thumbnail_bytes: u64,
    pub rendered_bytes: u64,
}

/// 受控缓存清理结果；文件计数与释放空间均使用无符号整数。
#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheCleanupReport {
    pub removed_files: usize,
    pub freed_bytes: u64,
    pub skipped_files: usize,
    pub failed_files: usize,
}
