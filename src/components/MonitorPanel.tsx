import type { Monitor, Position, ScreenWallpaper, Wallpaper } from "../lib/types";
import { POSITION_LABELS, isPortrait, monitorSize } from "../lib/types";
import { assetUrl } from "../lib/api";
import { IconCheck, IconLayers, IconMonitor, IconRefresh } from "./icons";

interface Props {
  monitors: Monitor[];
  selected: Set<string>;
  /** 每块屏当前实际展示的壁纸 */
  wallpaperMap: Map<string, ScreenWallpaper>;
  /** 用户在壁纸库里选中的待投放壁纸 */
  pendingWallpaper: Wallpaper | null;
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
 *   1. 现在显示什么（当前壁纸预览）
 *   2. 接下来要放什么、放到哪（待投放壁纸 + 三个动作）
 *   3. 怎么铺（填充方式）
 *   4. 每块屏分别是什么状态（屏幕清单）
 *
 * 「当前壁纸」与「待投放壁纸」是两件事，必须分开呈现：
 * 用户刚打开应用时想知道的是桌面现状，而投放动作的宾语是他在库里挑的那张图。
 * 把两者混成同一个预览框，会导致「面板显示 A，点应用却设成 B」的困惑。
 */
export function MonitorPanel({
  monitors,
  selected,
  wallpaperMap,
  pendingWallpaper,
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
  const selectedMonitors = monitors.filter((m) => selected.has(m.identity));
  const single = selectedMonitors.length === 1 ? selectedMonitors[0] : null;
  const physical = monitors.filter((m) => m.kind !== "virtual");

  /** 当前壁纸预览的焦点屏：选中单块时看那块，否则看主屏 */
  const focusMonitor = single ?? monitors.find((m) => m.primary) ?? monitors[0] ?? null;
  const focusWallpaper = focusMonitor ? wallpaperMap.get(focusMonitor.identity) : undefined;

  const setCount = monitors.filter((m) => wallpaperMap.get(m.identity)?.preview).length;
  const hasTarget = selectedMonitors.length > 0;
  const canApply = !!pendingWallpaper && !busy;
  const canSpan = physical.length >= 2 && !!pendingWallpaper && !busy;

  return (
    <aside className="panel">
      {/* ---- 1. 当前显示 ---- */}
      <section className="panel-block panel-current">
        {focusWallpaper?.preview ? (
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
            <span className="panel-label-plain">目标屏幕 · 未选择（将作用于全部）</span>
          )}
        </div>

        <div className={`pending${pendingWallpaper ? " is-set" : ""}`}>
          {pendingWallpaper ? (
            <>
              <span className="pending-thumb">
                <img src={assetUrl(pendingWallpaper.thumbPath)} alt="" />
              </span>
              <span className="pending-info">
                <span className="pending-name" title={pendingWallpaper.name}>
                  {pendingWallpaper.name}
                </span>
                <span className="pending-meta">
                  {pendingWallpaper.width}×{pendingWallpaper.height} ·{" "}
                  {ratioLabel(pendingWallpaper.width, pendingWallpaper.height)}
                </span>
              </span>
            </>
          ) : (
            <span className="pending-hint">在下方壁纸库中点击一张图</span>
          )}
        </div>

        <button className="action-primary" onClick={onApplyAll} disabled={!canApply}>
          {pendingWallpaper
            ? hasTarget
              ? `应用到选中 ${selectedMonitors.length} 块屏`
              : `应用到全部 ${physical.length} 块屏`
            : "先选一张壁纸"}
        </button>

        <button
          className="action-secondary"
          onClick={onApplySelected}
          disabled={!canApply || !hasTarget}
        >
          <IconMonitor size={14} />
          仅应用到选中屏幕
          {hasTarget && <span className="kbd">{selectedMonitors.length}</span>}
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
          填充保持比例裁切铺满、不留黑边；适应完整显示但可能留边
        </p>
      </section>

      {/* ---- 4. 屏幕清单 ---- */}
      <section className="panel-block panel-screens">
        <div className="panel-label">
          屏幕状态
          <span className="panel-label-tail">
            {setCount}/{monitors.length}
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
                onClick={(e) => onToggleSelect(m.identity, e.ctrlKey || e.metaKey)}
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
                <span className={`screen-state${sw?.preview ? " is-set" : ""}`}>
                  {sw?.preview ? <IconCheck size={11} /> : "空"}
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
