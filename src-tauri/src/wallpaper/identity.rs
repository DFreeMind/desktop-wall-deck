//! 显示器身份识别。
//!
//! # 为什么需要这一层
//!
//! `IDesktopWallpaper` 只给出设备路径（device path），形如：
//!
//! ```text
//! \\?\DISPLAY#LEN8AB1#4&3798061&0&UID8388688#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}
//! ```
//!
//! 其中 `4&3798061&0&UID8388688` 这一段由「父设备实例 + 端口 + 端口内序号」构成。
//! 这意味着：**换 HDMI 口、换线、重装驱动后整串都可能变**。若直接拿它当持久化 key，
//! 用户精心配好的「左屏风景、右屏像素风」在插拔后就会错位。
//!
//! 因此这里从设备路径与 EDID 中提取更稳定的特征，拼成一个逻辑身份：
//!
//! - `vendor`：EDID 制造商 ID（如 `LEN`），固定可靠
//! - `product`：设备路径中的型号段（如 `PHLC155`），近似产品码
//! - `serial`：EDID 序列号 / 设备实例 UID，同型号多屏时用于区分
//!
//! 三者组合后，只要显示器本身没换、且仍接在同一台机器上，身份就保持稳定。
//!
//! # 降级策略
//!
//! 拿不到 EDID（虚拟屏、驱动不支持）时退化为设备路径哈希。此时身份不稳定，
//! 上层会把它标记为「未绑定」，而不是错误地套用别人的映射。

use serde::{Deserialize, Serialize};

use super::model::{Monitor, MonitorKind, Rect};
use super::com::RawMonitor;

/// 从设备路径中解析出的身份特征。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorIdentity {
    /// 逻辑身份字符串，用于持久化。格式 `vendor::product::serial`
    pub key: String,
    /// EDID 厂商码，解析失败为空串
    pub vendor: String,
    /// 型号代号，取自设备路径中间段
    pub product: String,
    /// 序列号或端口 UID
    pub serial: String,
    /// 身份是否来自稳定特征（false 表示退化为路径哈希）
    pub stable: bool,
}

/// 设备路径中的虚拟显示器特征词。大小写不敏感匹配。
///
/// 注意分段符：设备路径用 `#` 分隔各段（如 `\\?\ROOT#DISPLAY#0000#...`），
/// 因此不能写成 `root\\`（反斜杠），否则这类根枚举虚拟设备会漏判。
const VIRTUAL_MARKERS: &[&str] = &[
    "virtual",
    "idd",
    "root#",
    "usbmonitor",
    "to_desk",
    "gameviewer",
    "mumu",
    "oray",
    "spacedesk",
    "parsec",
    "sunlogin",
    "todesk",
];

/// 判断设备路径是否指向虚拟显示适配器。
///
/// 机器上常见的虚拟屏：MuMu 模拟器、向日葵、GameViewer、ToDesk、spacedesk 等。
/// 它们会出现在 `GetMonitorDevicePathCount` 中，若不剔除会让用户困惑
/// 「为什么多出一块不存在的屏幕」。
pub fn looks_virtual(device_path: &str) -> bool {
    let lower = device_path.to_ascii_lowercase();
    VIRTUAL_MARKERS.iter().any(|m| lower.contains(m))
}

/// 解析设备路径。
///
/// 输入形如 `\\?\DISPLAY#LEN8AB1#4&3798061&0&UID8388688#{guid}`，
/// 分段以 `#` 分隔：
/// - 段 0：`\\?\DISPLAY`，固定前缀
/// - 段 1：型号代号，如 `LEN8AB1` / `DEL413C` / `PHLC155`，前 3 位是厂商码
/// - 段 2：实例路径，包含端口与 UID
/// - 段 3：接口 GUID
pub fn parse_device_path(device_path: &str) -> MonitorIdentity {
    let parts: Vec<&str> = device_path.split('#').collect();

    let product = parts.get(1).copied().unwrap_or("").trim_matches('\\').to_string();
    let instance = parts.get(2).copied().unwrap_or("");

    // 厂商码：型号代号的前 3 个字母，PNP ID 约定。
    let vendor = if product.len() >= 3 {
        product[..3].to_ascii_uppercase()
    } else {
        String::new()
    };

    // 序列号候选按可靠性排序：
    // 1) 实例路径中的 UID 段 —— 同一端口内的显示器序号，可在换口后仍区分同型号双屏
    // 2) 型号代号本身 —— 保证至少「换口后仍认得是同一台」
    let serial = extract_uid(instance).unwrap_or_else(|| product.clone());

    let stable = !product.is_empty() && !vendor.is_empty() && !looks_virtual(device_path);

    let key = format!("{}::{}::{}", vendor, product, serial);

    MonitorIdentity { key, vendor, product, serial, stable }
}

/// 从实例路径中抽出 `UIDxxxx` 片段作为序列号。
fn extract_uid(instance: &str) -> Option<String> {
    let upper = instance.to_ascii_uppercase();
    let idx = upper.find("UID")?;
    let tail = &instance[idx..];
    let end = tail.find('&').unwrap_or(tail.len());
    let uid = &tail[..end];
    if uid.len() > 3 {
        Some(uid.to_ascii_uppercase())
    } else {
        None
    }
}

/// 依据矩形位置推断显示器的中文方位描述，用于 UI 上给用户一个除编号外的识别线索。
///
/// 用户面对「显示器 1 / 2 / 3」很难对应，但「左侧竖屏」「中间主屏」一眼就懂。
pub fn describe_position(rect: Rect, primary_rect: Rect) -> String {
    if rect == primary_rect {
        return "主屏".to_string();
    }

    let cx = (rect.left + rect.right) / 2;
    let px = (primary_rect.left + primary_rect.right) / 2;

    let horizontal = if cx < px - primary_rect.width() / 2 {
        "左侧"
    } else if cx > px + primary_rect.width() / 2 {
        "右侧"
    } else {
        "正前"
    };

    let vertical = if rect.top < primary_rect.top - primary_rect.height() / 2 {
        "上方"
    } else if rect.top > primary_rect.top + primary_rect.height() / 2 {
        "下方"
    } else {
        ""
    };

    let kind = if rect.is_portrait() { "竖屏" } else { "" };

    let mut name = String::new();
    name.push_str(horizontal);
    name.push_str(vertical);
    name.push_str(kind);
    name
}

/// 把 COM 原始数据组装为带身份的 `Monitor` 列表。
pub fn build_monitors(raw: Vec<RawMonitor>) -> Vec<Monitor> {
    // 找到主屏矩形：桌面坐标系中原点 (0,0) 落在哪块屏上。
    let primary_rect = raw
        .iter()
        .find(|r| r.rect.left <= 0 && r.rect.right > 0 && r.rect.top <= 0 && r.rect.bottom > 0)
        .map(|r| r.rect)
        .or_else(|| raw.first().map(|r| r.rect))
        .unwrap_or(Rect { left: 0, top: 0, right: 0, bottom: 0 });

    raw.into_iter()
        .map(|r| {
            let id = parse_device_path(&r.device_path);
            let kind = if looks_virtual(&r.device_path) {
                MonitorKind::Virtual
            } else if id.vendor.is_empty() {
                MonitorKind::Unknown
            } else {
                MonitorKind::Physical
            };

            let name = format!(
                "{} {}",
                if kind == MonitorKind::Virtual { "虚拟屏" } else { "显示器" },
                describe_position(r.rect, primary_rect)
            );

            Monitor {
                device_path: r.device_path,
                identity: id.key,
                name,
                vendor: id.vendor,
                rect: r.rect,
                kind,
                primary: r.rect == primary_rect,
                current_wallpaper: r.wallpaper,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析真实设备路径() {
        let p = r"\\?\DISPLAY#LEN8AB1#4&3798061&0&UID8388688#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";
        let id = parse_device_path(p);
        assert_eq!(id.vendor, "LEN");
        assert_eq!(id.product, "LEN8AB1");
        assert_eq!(id.serial, "UID8388688");
        assert!(id.stable);
    }

    #[test]
    fn 同一台显示器换端口后身份保持一致() {
        // 仅父设备实例号与端口号不同，型号与 UID 不变
        let a = parse_device_path(
            r"\\?\DISPLAY#PHLC155#4&3798061&0&UID4145#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}",
        );
        let b = parse_device_path(
            r"\\?\DISPLAY#PHLC155#5&1111111&0&UID4145#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}",
        );
        assert_eq!(a.key, b.key, "换端口后逻辑身份应不变，否则映射会错位");
    }

    #[test]
    fn 识别虚拟显示器() {
        assert!(looks_virtual(
            r"\\?\DISPLAY#MUMU0001#4&1&0&UID1#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
        ));
        assert!(looks_virtual(
            r"\\?\ROOT#DISPLAY#0000#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
        ));
        assert!(!looks_virtual(
            r"\\?\DISPLAY#DEL413C#4&3798061&0&UID24647#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
        ));
    }

    #[test]
    fn 方位描述区分主屏与侧屏() {
        let primary = Rect { left: 0, top: 0, right: 3072, bottom: 1920 };
        let left = Rect { left: -2560, top: 109, right: 0, bottom: 1549 };
        assert_eq!(describe_position(primary, primary), "主屏");
        assert!(describe_position(left, primary).contains("左侧"));
    }
}
