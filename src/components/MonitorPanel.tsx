import type { Monitor, Position, Wallpaper } from "../lib/types";
import { POSITION_LABELS, isPortrait, monitorSize } from "../lib/types";

interface Props {
  monitors: Monitor[];
  selected: Set<string>;
  wallpapers: Wallpaper[];
  activeWallpaper: Wallpaper | null;
  position: Position;
  onPositionChange: (p: Position) => void;
  fitMessage: string | null;
  onApplyAll: () => void;
  onApplySelected: () => void;
  onApplySpan: () => void;
  busy: boolean;
}

const POSITIONS: Position[] = ["fill", "fit", "stretch", "center", "tile"];

/**
 * 右侧属性面板。
 *
 * 信息层级：当前选中对象 → 可执行的三个动作 → 填充方式 → 比例风险提示。
 * 把「比例提示」放在最后但始终可见，是因为它是用户设置完才发现问题的高频来源。
 */
export function MonitorPanel({
  monitors,
  selected,
  wallpapers,
  activeWallpaper,
  position,
  onPositionChange,
  fitMessage,
  onApplyAll,
  onApplySelected,
  onApplySpan,
  busy,
}: Props) {
  const selectedMonitors = monitors.filter((m) => selected.has(m.identity));
  const single = selectedMonitors.length === 1 ? selectedMonitors[0] : null;
  const physical = monitors.filter((m) => m.kind !== "virtual");

  const canSpan = physical.length >= 2 && !!activeWallpaper;
  const canApply = !!activeWallpaper && !busy;

  return (
    <aside className="panel">
      <header className="panel-head">
        {single ? (
          <>
            <h2>{single.name}</h2>
            <p className="sub">
              {single.vendor || "未知厂商"} · {describe(single)}
            </p>
          </>
        ) : selectedMonitors.length > 1 ? (
          <>
            <h2>已选 {selectedMonitors.length} 块屏</h2>
            <p className="sub">{selectedMonitors.map((m) => m.name).join("、")}</p>
          </>
        ) : (
          <>
            <h2>未选择显示器</h2>
            <p className="sub">点击画布中的屏幕以单独设置</p>
          </>
        )}
      </header>

      <div className="panel-section">
        <div className="panel-label">将壁纸应用到</div>
        <button className="wide primary" onClick={onApplyAll} disabled={!canApply}>
          {activeWallpaper ? `全部屏幕 · 使用「${activeWallpaper.name}」` : "全部屏幕"}
        </button>
        <button
          className="wide"
          onClick={onApplySelected}
          disabled={!canApply || selectedMonitors.length === 0}
        >
          仅选中屏幕
          {selectedMonitors.length > 0 ? `（${selectedMonitors.length}）` : ""}
        </button>
        <button className="wide" onClick={onApplySpan} disabled={!canSpan || busy}>
          跨屏拼接 · 一张图铺满 {physical.length} 块屏
        </button>
        {!canSpan && physical.length >= 2 && (
          <p className="note">跨屏拼接需要先在壁纸库中选择一张图</p>
        )}
      </div>

      <div className="panel-section">
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
        <p className="note">
          填充会保持比例并裁切铺满，不会留黑边；适应会完整显示但可能留边
        </p>
      </div>

      {activeWallpaper && (
        <div className="panel-section">
          <div className="panel-label">当前壁纸</div>
          <div className="chosen">
            <div>
              <div className="chosen-name">{activeWallpaper.name}</div>
              <div className="chosen-meta">
                {activeWallpaper.width}×{activeWallpaper.height}
              </div>
            </div>
          </div>
          {fitMessage && <div className="fit-warn">{fitMessage}</div>}
        </div>
      )}

      <div className="panel-foot">
        <span className="dim">{wallpapers.length} 张壁纸</span>
        <span className="dim">{monitors.length} 块屏</span>
      </div>
    </aside>
  );
}

function describe(m: Monitor): string {
  const { w, h } = monitorSize(m);
  const parts = [`${w}×${h}`];
  if (isPortrait(m)) parts.push("竖屏");
  if (m.primary) parts.push("主屏");
  if (m.kind === "virtual") parts.push("虚拟屏");
  return parts.join(" · ");
}
