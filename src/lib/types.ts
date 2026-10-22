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
  /** 所属文件夹；null 表示位于库根目录 */
  folderId: string | null;
}

/** 壁纸文件夹，`parentId` 自引用构成目录树。 */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

/**
 * 带统计的目录节点。
 *
 * `directCount` 是本层直接存放的张数，`totalCount` 含所有后代。
 * 列表上显示总数（用户关心「这个合集里一共多少张」），
 * 空判断用 `directCount`（避免「有子合集但本层为空」被误判为空）。
 */
export interface FolderNode extends Folder {
  directCount: number;
  totalCount: number;
  children: string[];
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
  | { type: "all"; value: { includeVirtual: boolean } }
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

/** 本机目录预扫描结果。`total - alreadyInLibrary` 才是导入后会新增的张数。 */
export interface FolderScan {
  path: string;
  total: number;
  alreadyInLibrary: number;
}

/**
 * 一块屏当前展示的壁纸。
 *
 * 之所以需要这个包装类型：系统当前壁纸未必来自本库。库里有的图可以直接
 * 走 asset 协议按路径加载；库里没有的图（用户手动设的、Windows 聚焦的）
 * 只能靠后端解码成 data URL。两者共用同一套「画面上显示什么」的逻辑，
 * 用联合类型明确区分来源，比在组件里到处判断「有没有命中库」更清楚。
 */
export type ScreenWallpaper =
  | { kind: "library"; wallpaper: Wallpaper; preview: string }
  | { kind: "external"; preview: string | null };

/** 判断是否为系统外部壁纸（用于「非本库图片」这类提示文案）。 */
export function isExternal(w: ScreenWallpaper | undefined): boolean {
  return !!w && w.kind === "external";
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

/**
 * 当前浏览范围。
 *
 * 之所以不用「folderId + recursive 布尔值」两个独立状态，是因为
 * 「全部壁纸」「未归类」「某个合集（含子集）」是互斥的三种视图，
 * 用联合类型表达可以避免出现「folderId 为空但 recursive 为真」这类无意义组合。
 */
export type LibraryScope =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; id: string; recursive: boolean };

export function scopeKey(s: LibraryScope): string {
  if (s.kind === "all") return "all";
  if (s.kind === "unfiled") return "unfiled";
  return `folder:${s.id}:${s.recursive ? "deep" : "flat"}`;
}
