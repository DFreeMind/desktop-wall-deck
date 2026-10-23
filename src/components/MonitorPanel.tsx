import type { Monitor, Position, ScreenWallpaper, Wallpaper } from "../lib/types";
import { POSITION_LABELS, isPortrait, monitorSize } from "../lib/types";
import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { IconCheck, IconExpand, IconLayers, IconMonitor, IconRefresh } from "./icons";

interface Props {
  monitors: Monitor[];
  selected: Set<string>;
  /** 每块屏当前实际展示的壁纸 */
  wallpaperMap: Map<string, ScreenWallpaper>;
  /** 用户在壁纸库里选中的待投放壁纸 */
  pendingWallpaper: Wallpaper | null;
  onPreview: (wallpaper: Wallpaper) => void;
  onRelink: (wallpaper: Wallpaper) => void;
  position: Position;
  onPositionChange: (p: Position) => void;
  fitMessage: string | null;
  onApplyAll: () => void;
  onApplySelected: () => void;
  onApplySpan: () => void;
  busy: boolean;
  onClearSelection: () => void;
  /** 与画布共用同一套选择语义（点击切换、按住 Ctrl 追加） */
  onToggleSelect: (identity: string, additive: boolean) => void;
  /** 刷新显示器信息，用于「当前壁纸来自系统」时重新同步 */
  onRefresh: () => void;
}

const POSITIONS: Position[] = ["fill", "fit", "stretch", "center", "tile"];

/**
 * 右侧属性面板。
 *
 * 分四块，自上而下回答四个问题：
 *
 *   1. 选中了什么（待应用预览，未选图时显示当前壁纸）
 *   2. 接下来要放什么、放到哪（待投放壁纸 + 三个动作）
 *   3. 怎么铺（填充方式）
 *   4. 每块屏分别是什么状态（屏幕清单）
 *
 * 「当前壁纸」与「待投放壁纸」是两件事，必须分开呈现：
 * 用户刚打开应用时想知道的是桌面现状，而投放动作的宾语是他在库里挑的那张图。
 * 预览优先展示待应用图片并明确标记，屏幕清单仍用当前实际壁纸缩略图。
 */
export function MonitorPanel({
  monitors,
  selected,
  wallpaperMap,
  pendingWallpaper,
  onPreview,
  onRelink,
  position,
  onPositionChange,
  fitMessage,
  onApplyAll,
  onApplySelected,
  onApplySpan,
  busy,
  onClearSelection,
  onToggleSelect,
  onRefresh,
}: Props) {
  const thumbnailRevision = useThumbnailRevision();
  const selectedMonitors = monitors.filter((m) => selected.has(m.identity));
  const single = selectedMonitors.length === 1 ? selectedMonitors[0] : null;
  const physical = monitors.filter((m) => m.kind !== "virtual");

  /** 当前壁纸预览的焦点屏：选中单块时看那块，否则看主屏 */
  const focusMonitor = single ?? monitors.find((m) => m.primary) ?? monitors[0] ?? null;
  const focusWallpaper = focusMonitor ? wallpaperMap.get(focusMonitor.identity) : undefined;

  const hasTarget = selectedMonitors.length > 0;
  const canApply = !!pendingWallpaper && !pendingWallpaper.missing && !busy;
  const canSpan = physical.length >= 2 && canApply;

  return (
    <aside className="panel">
      {/* ---- 1. 当前显示 ---- */}
      <section className="panel-block panel-current">
        {pendingWallpaper ? (
          <>
            <div className="current-frame">
              <img src={assetUrl(pendingWallpaper.thumbPath, thumbnailVersion(thumbnailRevision, pendingWallpaper.id))} alt={pendingWallpaper.name} decoding="async" />
              <span className="current-tag">待应用预览</span>
              <button className="current-expand" title="查看当前选择的大图" onClick={() => onPreview(pendingWallpaper)}><IconExpand size={14} />查看大图</button>
            </div>
            <div className="current-meta">
              <span className="current-name" title={pendingWallpaper.name}>{pendingWallpaper.name}</span>
              <span className="current-screen">{pendingWallpaper.width}×{pendingWallpaper.height} · {ratioLabel(pendingWallpaper.width, pendingWallpaper.height)} · 应用后生效</span>
            </div>
          </>
        ) : focusWallpaper?.preview ? (
          <>
            <div className="current-frame">
              <img src={focusWallpaper.preview} alt="" />
              <span className="current-tag">
                {focusWallpaper.kind === "library" ? "库内" : "系统"}
              </span>
            </div>
            <div className="current-meta">
              <span className="current-name">
                {focusWallpaper.kind === "library"
                  ? focusWallpaper.wallpaper.name
                  : "非库内图片"}
              </span>
              <span className="current-screen">{focusMonitor?.name ?? ""}</span>
            </div>
          </>
        ) : (
          <div className="current-empty">
            <span className="current-empty-icon">
              <IconLayers size={20} />
            </span>
            <div className="current-empty-text">
              <span className="current-empty-title">
                {focusWallpaper ? "预览不可用" : "这块屏还没有壁纸"}
              </span>
              <span className="current-empty-hint">
                {focusWallpaper
                  ? "原文件可能已被移动或删除"
                  : "从下方壁纸库挑一张，拖到屏幕上即可"}
              </span>
            </div>
            {focusWallpaper && (
              <button className="icon-plain" onClick={onRefresh} title="重新读取">
                <IconRefresh size={13} />
              </button>
            )}
          </div>
        )}
      </section>

      {/* ---- 2. 待投放 + 主操作 ---- */}
      <section className="panel-block">
        <div className="panel-label">
          {single ? (
            <>
              目标屏幕
              <strong>{single.name}</strong>
              <button className="link-btn" onClick={onClearSelection}>
                取消
              </button>
            </>
          ) : selectedMonitors.length > 1 ? (
            <>
              目标屏幕
              <strong>{selectedMonitors.length} 块</strong>
              <button className="link-btn" onClick={onClearSelection}>
                清除
              </button>
            </>
          ) : (
            <span className="panel-label-plain">目标屏幕 · 尚未选择</span>
          )}
        </div>

        {!pendingWallpaper && <div className="pending"><span className="pending-hint">在壁纸库中选择一张图，只会预览</span></div>}
        {pendingWallpaper?.missing && <div className="source-unavailable" role="status"><strong>原文件已移动或暂时离线</strong><span>原文件恢复后可继续使用，当前桌面的投放缓存仍会保留。</span>{pendingWallpaper.storageKind === "indexed" && <button className="link-btn" onClick={() => onRelink(pendingWallpaper)}>重新定位原文件</button>}</div>}

        <button className="action-primary" onClick={onApplySelected} disabled={!canApply || !hasTarget || position === "tile"}>
          {pendingWallpaper?.missing ? "原文件不可用"
            : pendingWallpaper
            ? hasTarget
              ? `应用到选中 ${selectedMonitors.length} 块屏`
              : "先选择目标显示器"
            : "先选一张壁纸"}
        </button>

        <button
          className="action-secondary"
          onClick={onApplyAll}
          disabled={!canApply || monitors.length === 0}
        >
          <IconMonitor size={14} />
          应用到全部 {monitors.length} 块屏幕
        </button>

        <button className="action-secondary" onClick={onApplySpan} disabled={!canSpan}>
          <IconLayers size={14} />
          跨屏拼接铺满 {physical.length} 块屏
        </button>

        {fitMessage && <div className="fit-warn">{fitMessage}</div>}
      </section>

      {/* ---- 3. 填充方式 ---- */}
      <section className="panel-block">
        <div className="panel-label">填充方式</div>
        <div className="segmented">
          {POSITIONS.map((p) => (
            <button
              key={p}
              className={position === p ? "is-on" : ""}
              onClick={() => onPositionChange(p)}
            >
              {POSITION_LABELS[p]}
            </button>
          ))}
        </div>
        <p className="panel-hint">
          {position === "tile" ? "平铺属于系统全屏模式，仅可使用“应用到全部”；单屏请选其他方式。" : "填充保持比例裁切铺满、不留黑边；适应完整显示但可能留边"}
        </p>
      </section>

      {/* ---- 4. 屏幕清单 ---- */}
      <section className="panel-block panel-screens">
        <div className="panel-label">
          选择目标屏幕
          <span className="panel-label-tail">
            已选 {selectedMonitors.length}/{monitors.length}
          </span>
        </div>
        <ul className="screen-list">
          {monitors.map((m) => {
            const on = selected.has(m.identity);
            const sw = wallpaperMap.get(m.identity);
            const { w, h } = monitorSize(m);
            const label =
              sw?.kind === "library" ? sw.wallpaper.name : sw ? "系统壁纸" : "未设置";
            return (
              <li
                key={m.identity}
                className={`screen-row${on ? " is-on" : ""}`}
                onClick={() => onToggleSelect(m.identity, true)}
                role="checkbox"
                aria-label={m.name}
                aria-checked={on}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleSelect(m.identity, true); }
                }}
                title={`当前：${label}`}
              >
                <span
                  className="screen-thumb"
                  style={{
                    aspectRatio: `${w} / ${h}`,
                    backgroundImage: sw?.preview ? `url("${sw.preview}")` : undefined,
                  }}
                  data-blank={sw?.preview ? undefined : "true"}
                />
                <span className="screen-info">
                  <span className="screen-row-name">{m.name}</span>
                  <span className="screen-row-meta">
                    {w}×{h}
                    {isPortrait(m) ? " · 竖" : ""}
                    {m.primary ? " · 主屏" : ""}
                    {m.kind === "virtual" ? " · 虚拟" : ""}
                  </span>
                </span>
                <span className={`screen-state screen-pick${on ? " is-chosen" : ""}`} aria-hidden>
                  {on && <IconCheck size={11} />}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

/** 比例的人类可读描述，比裸数字更容易判断是否适配屏幕。 */
function ratioLabel(w: number, h: number): string {
  if (h === 0) return "";
  const r = w / h;
  if (r > 2.1) return "超宽";
  if (r >= 1.7) return "16:9";
  if (r >= 1.5) return "16:10";
  if (r >= 1.3) return "4:3";
  if (r >= 0.95) return "方图";
  return "竖图";
}
