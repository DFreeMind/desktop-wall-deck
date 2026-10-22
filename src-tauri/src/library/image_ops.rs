//! 图片读取与处理。
//!
//! 职责边界：本模块只处理「文件 → 像素 / 缩略图」的转换，不涉及数据库与业务规则。
//!
//! # 为什么要统一转码
//!
//! `SetWallpaper` 虽然接受 jpg/png/bmp 等格式，但存在两个坑：
//!
//! 1. **EXIF 方向不生效**：Windows 壁纸接口会忽略 EXIF `Orientation` 标签，
//!    竖拍照片会横着铺满屏幕。必须在入库时按 EXIF 做物理旋转。
//! 2. **格式支持不全**：webp / avif / heic 等在部分系统版本上设置后变黑屏。
//!
//! 因此库内统一规范化为 PNG（无损，避免二次压缩劣化渐变），
//! 原始文件仅作参考保留，投放时始终使用规范化副本的绝对路径。

use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, RgbaImage};

use super::error::{LibError, LibResult};

/// 缩略图长边尺寸。列表视图按 220px 渲染，2 倍屏足够。
pub const THUMB_EDGE: u32 = 440;

/// 支持的源文件扩展名（小写，不含点）。
pub const SUPPORTED_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "bmp", "gif", "webp", "tif", "tiff", "avif",
];

/// 判断文件是否属于支持的图片类型。
pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            SUPPORTED_EXT.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// 读取 EXIF 方向标签（1..=8）。无 EXIF 或解析失败时返回 1（正向）。
fn read_exif_orientation(path: &Path) -> u8 {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut reader = std::io::BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v.clamp(1, 8) as u8)
        .unwrap_or(1)
}

/// 应用 EXIF 方向旋转，使图片按「肉眼看的样子」存正。
fn apply_orientation(img: DynamicImage, orientation: u8) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 读取图片并按 EXIF 校正方向。
pub fn load_oriented(path: &Path) -> LibResult<DynamicImage> {
    if !path.exists() {
        return Err(LibError::NotFound(path.display().to_string()));
    }
    let img = image::open(path)
        .map_err(|e| LibError::Decode(format!("{}：{e}", path.display())))?;
    let orientation = read_exif_orientation(path);
    Ok(apply_orientation(img, orientation))
}

/// 生成缩略图字节（PNG），长边不超过 `THUMB_EDGE`。
///
/// 使用 `thumbnail` 而非 `resize`：前者是面积平均采样，缩小时不会出现锯齿。
pub fn make_thumbnail(img: &DynamicImage) -> LibResult<Vec<u8>> {
    let thumb = img.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| LibError::Encode(format!("缩略图编码失败：{e}")))?;
    Ok(buf.into_inner())
}

/// 规范化后的存储格式。
///
/// # 为什么不用 PNG
///
/// 初版把一切转成 PNG 以求「无损」，实测代价过高：一张 1.4MB 的 JPEG 壁纸
/// 转 PNG 后变成 2.7MB，2520×2100 的图更是到 8.8MB。壁纸库动辄上百张，
/// 磁盘会迅速吃满；而且屏幕上根本看不出差别。
///
/// 改为高质 JPEG（92）后，体积通常低于原图，视觉上无可察觉损失。
/// 唯一例外是带透明通道的图——JPEG 不支持 alpha，转过去会变黑底，
/// 这类图仍用 PNG。
const JPEG_QUALITY: u8 = 92;

/// 判断图片是否含透明像素。只有这种情况才值得保留 PNG。
fn has_alpha_channel(img: &DynamicImage) -> bool {
    img.color().has_alpha()
}

/// 把图片规范化为适合壁纸使用的文件，返回 `(写入路径, 宽, 高)`。
///
/// 扩展名由内容决定：带透明通道写 `.png`，其余写 `.jpg`。
pub fn normalize_for_wallpaper(
    img: &DynamicImage,
    base_path: &Path,
) -> LibResult<(PathBuf, u32, u32)> {
    // 目录兜底，避免上层漏建
    if let Some(parent) = base_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LibError::Io(format!("创建目录失败 {}：{e}", parent.display())))?;
    }

    let (dest, format) = if has_alpha_channel(img) {
        (base_path.with_extension("png"), ImageFormat::Png)
    } else {
        (base_path.with_extension("jpg"), ImageFormat::Jpeg)
    };

    if format == ImageFormat::Jpeg {
        // JPEG 不支持 alpha，若不转 RGB，编码会失败或写出异常色值
        let rgb = img.to_rgb8();
        let file = std::fs::File::create(&dest)
            .map_err(|e| LibError::Io(format!("创建 {} 失败：{e}", dest.display())))?;
        let writer = std::io::BufWriter::new(file);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
        encoder
            .encode_image(&rgb)
            .map_err(|e| LibError::Encode(format!("JPEG 编码失败：{e}")))?;
    } else {
        img.save_with_format(&dest, format)
            .map_err(|e| LibError::Encode(format!("写入 {} 失败：{e}", dest.display())))?;
    }

    Ok((dest, img.width(), img.height()))
}

/// 跨屏拼接的结果：某个屏幕对应的图片分片。
pub struct Slice {
    pub monitor_device_path: String,
    pub image: RgbaImage,
}

/// 按显示器在桌面坐标系中的位置，从一整张大图切出各自的分片。
///
/// # 为什么不用 SetPosition(SPAN)
///
/// Windows 的 SPAN 模式只在所有显示器构成**连续矩形**时正确。
/// 现实中副屏纵向偏移几乎不可避免（分辨率或任务栏高度不同），
/// SPAN 会把这些空隙填成背景色，出现难看的黑边。
/// 因此改为本地切图：拼接图被理解为一整块画布，每块屏取自己那一格。
///
/// # 参数
///
/// - `source`：拼接大图，其宽高比应与显示器包围盒的总宽高比一致
/// - `monitors`：`(设备路径, 相对包围盒的矩形)`，使用包围盒坐标系（原点在左上）
pub fn slice_span(
    source: &DynamicImage,
    monitors: &[(String, (i32, i32, i32, i32))],
    bounds_w: i32,
    bounds_h: i32,
) -> Vec<Slice> {
    let scale_x = source.width() as f32 / bounds_w.max(1) as f32;
    let scale_y = source.height() as f32 / bounds_h.max(1) as f32;

    monitors
        .iter()
        .filter_map(|(path, (l, t, r, b))| {
            let x = (*l as f32 * scale_x).round().max(0.0) as u32;
            let y = (*t as f32 * scale_y).round().max(0.0) as u32;
            let w = ((r - l) as f32 * scale_x).round().max(1.0) as u32;
            let h = ((b - t) as f32 * scale_y).round().max(1.0) as u32;

            // 越界裁剪：拼接图宽高比与包围盒不一致时，边缘屏可能算出超界区域
            let w = w.min(source.width().saturating_sub(x)).max(1);
            let h = h.min(source.height().saturating_sub(y)).max(1);

            let piece = source.crop_imm(x, y, w, h).to_rgba8();
            Some(Slice { monitor_device_path: path.clone(), image: piece })
        })
        .collect()
}

/// 计算图片与屏幕的适配建议，供 UI 提前提示裁切风险。
///
/// 返回 `(是否需要裁切, 建议文案)`。竖屏配横图是最常见的「设完才发现构图被切」场景。
pub fn fit_advice(img_w: u32, img_h: u32, screen_w: i32, screen_h: i32) -> (bool, String) {
    if img_w == 0 || img_h == 0 || screen_w <= 0 || screen_h <= 0 {
        return (false, String::new());
    }
    let img_ratio = img_w as f32 / img_h as f32;
    let screen_ratio = screen_w as f32 / screen_h as f32;
    let diff = (img_ratio - screen_ratio).abs() / screen_ratio;

    if diff < 0.05 {
        (false, "比例匹配，可完整呈现".into())
    } else if img_ratio > screen_ratio {
        let keep = (screen_ratio / img_ratio * 100.0).round();
        (true, format!("图片偏宽，填充将左右裁切，保留约 {keep:.0}% 宽度"))
    } else {
        let keep = (img_ratio / screen_ratio * 100.0).round();
        (true, format!("图片偏高，填充将上下裁切，保留约 {keep:.0}% 高度"))
    }
}

/// 库内文件**基**路径：`<库根>/files/<id 前两位>/<id>`，扩展名由内容决定后追加。
///
/// 二级目录避免单目录文件过多导致的浏览卡顿。
pub fn library_file_base(root: &Path, id: &str) -> PathBuf {
    let prefix = &id[..2.min(id.len())];
    root.join("files").join(prefix).join(id)
}

/// 缩略图缓存路径。
pub fn thumb_file_path(root: &Path, id: &str) -> PathBuf {
    let prefix = &id[..2.min(id.len())];
    root.join("thumbs").join(prefix).join(format!("{id}.png"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 比例匹配时不提示裁切() {
        let (warn, _) = fit_advice(1920, 1080, 1920, 1080);
        assert!(!warn);
    }

    #[test]
    fn 竖屏配横图时提示裁切() {
        let (warn, msg) = fit_advice(1920, 1080, 1440, 1920);
        assert!(warn);
        assert!(msg.contains("裁切"));
    }

    #[test]
    fn 扩展名识别不区分大小写() {
        assert!(is_supported(Path::new("a.JPG")));
        assert!(is_supported(Path::new("b.Png")));
        assert!(!is_supported(Path::new("c.txt")));
    }
}
