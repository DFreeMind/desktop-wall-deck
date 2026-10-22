/**
 * 与后端 Rust 命令对应的类型声明。
 *
 * 这里的字段名由后端 `#[serde(rename_all = "camelCase")]` 保证，
 * 修改 Rust 结构体时必须同步本文件，否则运行时会出现字段为 undefined 的静默错误。
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type MonitorKind = "physical" | "virtual" | "unknown";

export interface Monitor {
  /** 易变的设备路径，用于设置壁纸，不可作为持久化 key */
  devicePath: string;
  /** 稳定的逻辑身份，用于记忆绑定关系 */
  identity: string;
  name: string;
  vendor: string;
  rect: Rect;
  kind: MonitorKind;
  primary: boolean;
  /** 系统当前为该屏设置的壁纸绝对路径，可能来自本应用以外 */
  currentWallpaper: string | null;
}

export interface Topology {
  monitors: Monitor[];
  bounds: Rect;
}

export interface Wallpaper {
  id: string;
  name: string;
  filePath: string;
  thumbPath: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

export type Position = "fill" | "fit" | "stretch" | "center" | "tile";

export const POSITION_LABELS: Record<Position, string> = {
  fill: "填充",
  fit: "适应",
  stretch: "拉伸",
  center: "居中",
  tile: "平铺",
};

export type Target =
  | { type: "all" }
  | { type: "identities"; value: string[] };

export interface ApplyResult {
  applied: number;
  skipped: string[];
}

export interface ImportReport {
  added: number;
  skipped: number;
  failed: { path: string; reason: string }[];
}

export interface FitAdvice {
  needsCrop: boolean;
  message: string;
}

/** 显示器的可视化尺寸，保留真实宽高比，竖屏不会被压扁。 */
export function monitorAspect(m: Monitor): number {
  const w = m.rect.right - m.rect.left;
  const h = m.rect.bottom - m.rect.top;
  return h > 0 ? w / h : 16 / 9;
}

export function monitorSize(m: Monitor): { w: number; h: number } {
  return {
    w: m.rect.right - m.rect.left,
    h: m.rect.bottom - m.rect.top,
  };
}

export function isPortrait(m: Monitor): boolean {
  const { w, h } = monitorSize(m);
  return h > w;
}
