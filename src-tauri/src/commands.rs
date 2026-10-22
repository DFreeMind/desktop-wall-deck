//! Tauri 命令层：前端唯一调用面。
//!
//! 约定：命令只做参数校验与编排，业务逻辑留在 `wallpaper` / `library` 模块。
//! 所有命令返回 `Result<T, String>`，错误字符串可直接展示给用户。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::library::{image_ops, Folder, FolderNode, ImportReport, Wallpaper};
use crate::state::AppState;
use crate::wallpaper::identity::build_monitors;
use crate::wallpaper::{Position, Topology};

/// 统一的错误转换：把内部错误转成中文可读字符串。
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- 显示器

#[tauri::command]
pub fn list_monitors(state: State<'_, AppState>) -> Result<Topology, String> {
    let raw = state.worker.list_monitors().map_err(err)?;
    let monitors = build_monitors(raw);
    let topology = Topology::from_monitors(monitors);
    state.store_topology(topology.clone());
    Ok(topology)
}

/// 投放目标：全部屏幕，或指定的一组逻辑身份。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum Target {
    /// 所有物理显示器统一壁纸。
    ///
    /// 显式传 `true` 时连虚拟屏一起设置；默认只作用于物理屏，
    /// 因为虚拟屏（模拟器、串流）通常不是用户想统一的对象，
    /// 且系统级 NULL 会连带覆盖它们的独立配置。
    All { include_virtual: bool },
    /// 指定若干显示器，按逻辑身份匹配
    Identities(Vec<String>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub wallpaper_id: String,
    pub target: Target,
    /// fill / fit / stretch / center / tile
    #[serde(default = "default_position")]
    pub position: String,
}

fn default_position() -> String {
    "fill".into()
}

fn parse_position(s: &str) -> Position {
    match s {
        "center" => Position::Center,
        "tile" => Position::Tile,
        "stretch" => Position::Stretch,
        "fit" => Position::Fit,
        // 默认填充：绝大多数壁纸场景下观感最好，且不会留黑边
        _ => Position::Fill,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: usize,
    /// 因设备已断开等原因被跳过的显示器名称
    pub skipped: Vec<String>,
}

#[tauri::command]
pub fn apply_wallpaper(state: State<'_, AppState>, req: ApplyRequest) -> Result<ApplyResult, String> {
    let path = state
        .library
        .file_path_of(&req.wallpaper_id)
        .map_err(err)?
        .ok_or_else(|| "壁纸不存在，可能已被删除".to_string())?;

    let position = parse_position(&req.position);
    let topology = ensure_topology(&state)?;

    match req.target {
        Target::All { include_virtual } => {
            let targets: Vec<crate::wallpaper::model::Monitor> = topology
                .monitors
                .iter()
                .filter(|m| include_virtual || m.kind != crate::wallpaper::MonitorKind::Virtual)
                .cloned()
                .collect();

            if targets.is_empty() {
                return Err("没有可设置的物理显示器".into());
            }

            if include_virtual {
                // 语义为系统级统一壁纸：新插入的屏幕也会继承同一张图
                state.worker.set_wallpaper(None, &path, position).map_err(err)?;
            } else {
                // 逐屏投放，把虚拟屏排除在外，避免覆盖模拟器/串流的独立配置
                for m in &targets {
                    state
                        .worker
                        .set_wallpaper(Some(m.device_path.clone()), &path, position)
                        .map_err(|e| format!("设置「{}」失败：{e}", m.name))?;
                }
            }

            let bindings: Vec<_> = targets
                .iter()
                .map(|m| crate::library::MonitorBinding {
                    identity: m.identity.clone(),
                    wallpaper_id: Some(req.wallpaper_id.clone()),
                    position: req.position.clone(),
                })
                .collect();
            state.library.db().save_bindings(&bindings).map_err(err)?;

            Ok(ApplyResult { applied: targets.len(), skipped: vec![] })
        }
        Target::Identities(ids) => {
            if ids.is_empty() {
                return Err("未选择任何显示器".into());
            }
            let mut applied = 0;
            let mut skipped = Vec::new();
            let mut bindings = Vec::new();

            for identity in &ids {
                match topology.monitors.iter().find(|m| &m.identity == identity) {
                    Some(m) => {
                        state
                            .worker
                            .set_wallpaper(Some(m.device_path.clone()), &path, position)
                            .map_err(|e| format!("设置「{}」失败：{e}", m.name))?;
                        applied += 1;
                        bindings.push(crate::library::MonitorBinding {
                            identity: identity.clone(),
                            wallpaper_id: Some(req.wallpaper_id.clone()),
                            position: req.position.clone(),
                        });
                    }
                    None => skipped.push(format!("身份为 {identity} 的显示器已断开")),
                }
            }

            state.library.db().save_bindings(&bindings).map_err(err)?;
            Ok(ApplyResult { applied, skipped })
        }
    }
}

/// 保证拓扑已加载。多数命令依赖显示器列表，缺失时现拉一次。
fn ensure_topology(state: &AppState) -> Result<Topology, String> {
    if let Some(t) = state.cached_topology() {
        return Ok(t);
    }
    let raw = state.worker.list_monitors().map_err(err)?;
    let topology = Topology::from_monitors(build_monitors(raw));
    state.store_topology(topology.clone());
    Ok(topology)
}

// ---------------------------------------------------------------- 跨屏拼接

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanRequest {
    pub wallpaper_id: String,
    #[serde(default = "default_position")]
    pub position: String,
}

#[tauri::command]
pub fn apply_span(state: State<'_, AppState>, req: SpanRequest) -> Result<ApplyResult, String> {
    let path = state
        .library
        .file_path_of(&req.wallpaper_id)
        .map_err(err)?
        .ok_or_else(|| "壁纸不存在，可能已被删除".to_string())?;

    let topology = ensure_topology(&state)?;
    let physical: Vec<_> = topology
        .monitors
        .iter()
        .filter(|m| m.kind != crate::wallpaper::MonitorKind::Virtual)
        .collect();

    if physical.len() < 2 {
        return Err("跨屏拼接需要至少两块物理显示器".into());
    }

    // 统一到包围盒坐标系，再按每块屏的矩形切分
    let b = &topology.bounds;
    let rel: Vec<(String, (i32, i32, i32, i32))> = physical
        .iter()
        .map(|m| {
            (
                m.device_path.clone(),
                (
                    m.rect.left - b.left,
                    m.rect.top - b.top,
                    m.rect.right - b.left,
                    m.rect.bottom - b.top,
                ),
            )
        })
        .collect();

    let img = image_ops::load_oriented(std::path::Path::new(&path))
        .map_err(|e| format!("读取壁纸失败：{e}"))?;

    let slices = image_ops::slice_span(&img, &rel, b.width(), b.height());
    if slices.is_empty() {
        return Err("切图结果为空，请检查显示器布局".into());
    }

    // 分片写到临时目录。使用库数据目录下的 span 子目录，便于统一清理。
    let span_dir = state.data_dir.join("span");
    let _ = std::fs::remove_dir_all(&span_dir);
    std::fs::create_dir_all(&span_dir)
        .map_err(|e| format!("创建临时目录失败：{e}"))?;

    let position = parse_position(&req.position);
    let mut applied = 0;
    let mut bindings = Vec::new();

    for (idx, slice) in slices.iter().enumerate() {
        let piece_path = span_dir.join(format!("segment-{idx}.png"));
        slice
            .image
            .save_with_format(&piece_path, image::ImageFormat::Png)
            .map_err(|e| format!("写出分片失败：{e}"))?;

        state
            .worker
            .set_wallpaper(
                Some(slice.monitor_device_path.clone()),
                &piece_path.to_string_lossy(),
                // 分片尺寸已与屏幕一致，用填充即可 1:1 铺满
                position,
            )
            .map_err(|e| format!("设置分片 {idx} 失败：{e}"))?;
        applied += 1;

        if let Some(m) = physical.iter().find(|m| m.device_path == slice.monitor_device_path) {
            bindings.push(crate::library::MonitorBinding {
                identity: m.identity.clone(),
                wallpaper_id: Some(req.wallpaper_id.clone()),
                position: req.position.clone(),
            });
        }
    }

    state.library.db().save_bindings(&bindings).map_err(err)?;
    Ok(ApplyResult { applied, skipped: vec![] })
}

// ---------------------------------------------------------------- 壁纸库

#[tauri::command]
pub fn library_list(state: State<'_, AppState>) -> Result<Vec<Wallpaper>, String> {
    state.library.list().map_err(err)
}

/// 按文件夹筛选壁纸。
///
/// - `folderId` 为 `null` 时返回库根目录（未归入任何文件夹）的壁纸；
/// - `recursive` 为真时穿透所有子文件夹，这正是「查看合集全部内容」需要的能力。
#[tauri::command]
pub fn library_list_in_folder(
    state: State<'_, AppState>,
    folder_id: Option<String>,
    #[allow(non_snake_case)] recursive: bool,
) -> Result<Vec<Wallpaper>, String> {
    match folder_id {
        Some(fid) => state.library.list_in_folder(&fid, recursive).map_err(err),
        None => state.library.list_root_wallpapers().map_err(err),
    }
}

#[tauri::command]
pub fn library_import(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    folder_id: Option<String>,
) -> Result<ImportReport, String> {
    let pb: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let report = state
        .library
        .import(&pb, folder_id.as_deref())
        .map_err(err)?;
    // 导入完成后广播，让壁纸库视图自行刷新，无需前端轮询
    let _ = app.emit("library://changed", ());
    Ok(report)
}

#[tauri::command]
pub fn library_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.library.remove(&id).map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(())
}

#[tauri::command]
pub fn library_rename(app: AppHandle, state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.library.rename(&id, &name).map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(())
}

/// 库占用统计，返回 (张数, 字节数)。
#[tauri::command]
pub fn library_usage(state: State<'_, AppState>) -> Result<(usize, u64), String> {
    let list = state.library.list().map_err(err)?;
    let bytes = list.iter().map(|w| w.bytes).sum();
    Ok((list.len(), bytes))
}

// ---------------------------------------------------------------- 文件夹

#[tauri::command]
pub fn folder_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder, String> {
    let folder = state
        .library
        .create_folder(&name, parent_id.as_deref())
        .map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(folder)
}

#[tauri::command]
pub fn folder_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state.library.rename_folder(&id, &name).map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(())
}

/// 删除文件夹。内部壁纸与子文件夹上移一级，不会被连带删除。
#[tauri::command]
pub fn folder_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.library.delete_folder(&id).map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(())
}

/// 完整目录树（含每层直接数量与子树总数），一次拉取供前端渲染侧栏。
#[tauri::command]
pub fn folder_tree(state: State<'_, AppState>) -> Result<Vec<FolderNode>, String> {
    state.library.folder_tree().map_err(err)
}

#[tauri::command]
pub fn library_move_to_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    state
        .library
        .move_to_folder(&id, folder_id.as_deref())
        .map_err(err)?;
    let _ = app.emit("library://changed", ());
    Ok(())
}

// ---------------------------------------------------------------- 辅助信息

/// 图片与指定显示器是否匹配，供 UI 提前提示裁切。
#[tauri::command]
pub fn fit_advice(
    state: State<'_, AppState>,
    wallpaper_id: String,
    identity: String,
) -> Result<(bool, String), String> {
    let list = state.library.list().map_err(err)?;
    let wp = list
        .iter()
        .find(|w| w.id == wallpaper_id)
        .ok_or_else(|| "壁纸不存在".to_string())?;

    let topology = ensure_topology(&state)?;
    let monitor = topology
        .monitors
        .iter()
        .find(|m| m.identity == identity)
        .ok_or_else(|| "显示器不存在".to_string())?;

    Ok(image_ops::fit_advice(
        wp.width,
        wp.height,
        monitor.width(),
        monitor.height(),
    ))
}

/// 库图片的本地可访问 URL。
///
/// 前端不能直接读文件系统，统一走 Tauri 的 asset 协议。
#[tauri::command]
pub fn asset_url(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    Ok(format!("asset://localhost/{}", urlencode_path(&path)))
}

/// 简单路径转义：仅处理空格与中文等非 ASCII 字符需要的百分号编码。
fn urlencode_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut out = String::with_capacity(normalized.len());
    for byte in normalized.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 数据目录，供「打开文件夹」等操作使用。
#[tauri::command]
pub fn data_dir(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}
