import { assetUrl } from "../lib/api";
import type { Monitor, Position, Wallpaper } from "../lib/types";
import { POSITION_LABELS, isPortrait, monitorSize } from "../lib/types";
import { IconCheck, IconLayers, IconMonitor } from "./icons";
import { formatBytes } from "./WallpaperGrid";

interface Props {
  monitors: Monitor[];
  selected: Set<string>;
  activeWallpaper: Wallpaper | null;
  position: Position;
  onPositionChange: (p: Position) => void;
  fitMessage: string | null;
  onApplyAll: () => void;
  onApplySelected: () => void;
  onApplySpan: () => void;
  busy: boolean;
  /** 每块屏当前使用的壁纸，用于在屏幕清单里显示缩略图 */
  wallpaperMap: Map<string, Wallpaper>;
  onClearSelection: () => void;
  /** 与画布共用同一套选择语义（点击切换、按住 Ctrl 追加） */
  onToggleSelect: (identity: string, additive: boolean) => void;
}

const POSITIONS: Position[] = ["fill", "fit", "stretch", "center", "tile"];

/**
 * 右侧属性面板。
 *
 * 信息层级自下而上分四块，每块之间用留白和细分隔线分层：
 *
 *   1. 待设置对象（哪块屏 / 哪张图）—— 先说清楚「在操作什么」
 *   2. 主操作（三个投放动作）—— 面板里唯一的实心按钮
 *   3. 填充方式（分段控件）—— 次要选项
 *   4. 屏幕清单 —— 状态总览，可在此直接切选
 *
 * 把「比例风险提示」贴在主操作下方而不是最底部，
 * 因为它是用户设置完才发现问题的高频来源，必须紧挨着决策点。
 */
export function MonitorPanel({
  monitors,
  selected,
  activeWallpaper,
  position,
  onPositionChange,
  fitMessage,
  onApplyAll,
  onApplySelected,
  onApplySpan,
  busy,
  wallpaperMap,
  onClearSelection,
  onToggleSelect,
}: Props) {
  const selectedMonitors = monitors.filter((m) => selected.has(m.identity));
  const single = selectedMonitors.length === 1 ? selectedMonitors[0] : null;
  const physical = monitors.filter((m) => m.kind !== "virtual");

  const canSpan = physical.length >= 2 && !!activeWallpaper;
  const canApply = !!activeWallpaper && !busy;

  return (
    <aside className="panel">
      {/* ---- 1. 当前壁纸 ---- */}
      <section className="panel-block panel-preview">
        {activeWallpaper ? (
          <>
            <div className="preview-frame">
              <img src={assetUrl(activeWallpaper.filePath)} alt={activeWallpaper.name} />
            </div>
            <div className="preview-meta">
              <h2 className="preview-name" title={activeWallpaper.name}>
                {activeWallpaper.name}
              </h2>
              <p className="preview-sub">
                {activeWallpaper.width}×{activeWallpaper.height}
                <span className="dot" />
                {formatBytes(activeWallpaper.bytes)}
                <span className="dot" />
                {ratioLabel(activeWallpaper.width, activeWallpaper.height)}
              </p>
            </div>
          </>
        ) : (
          <div className="preview-empty">
            <span className="preview-empty-icon">
              <IconLayers size={22} />
            </span>
            <p className="preview-empty-title">未选择壁纸</p>
            <p className="preview-empty-hint">
              点下方任意一张图，即可设为壁纸；也可以把它拖到上方的屏幕上
            </p>
          </div>
        )}
      </section>

      {/* ---- 2. 目标与主操作 ---- */}
      <section className="panel-block">
        <div className="panel-label">
          {single ? (
            <>
              目标屏幕
              <strong>{single.name}</strong>
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
            <span className="panel-label-plain">目标屏幕 · 未选择</span>
          )}
        </div>

        <button className="action-primary" onClick={onApplyAll} disabled={!canApply}>
          {activeWallpaper
            ? selectedMonitors.length > 0
              ? `应用到全部 ${physical.length} 块屏`
              : `应用到全部 ${physical.length} 块屏`
            : "选择一张壁纸后应用"}
        </button>

        <button
          className="action-secondary"
          onClick={onApplySelected}
          disabled={!canApply || selectedMonitors.length === 0}
        >
          <IconMonitor size={14} />
          仅应用到选中屏幕
          {selectedMonitors.length > 0 && <span className="kbd">{selectedMonitors.length}</span>}
        </button>

        <button className="action-secondary" onClick={onApplySpan} disabled={!canSpan || busy}>
          <IconLayers size={14} />
          跨屏拼接铺满 {physical.length} 块屏
        </button>

        {!canSpan && physical.length >= 2 && !activeWallpaper && (
          <p className="panel-hint">跨屏拼接需要先在壁纸库中选一张图</p>
        )}
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
          <span className="panel-label-tail">{monitors.length}</span>
        </div>
        <ul className="screen-list">
          {monitors.map((m) => {
            const on = selected.has(m.identity);
            const wp = wallpaperMap.get(m.identity);
            const { w, h } = monitorSize(m);
            return (
              <li
                key={m.identity}
                className={`screen-row${on ? " is-on" : ""}`}
                onClick={(e) => onToggleSelect(m.identity, e.ctrlKey || e.metaKey)}
                title={wp ? `当前：${wp.name}` : "当前未设置本库中的壁纸"}
              >
                <span
                  className="screen-thumb"
                  style={{
                    aspectRatio: `${w} / ${h}`,
                    backgroundImage: wp ? `url("${assetUrl(wp.thumbPath)}")` : undefined,
                  }}
                  data-blank={wp ? undefined : "true"}
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
                <span className={`screen-state${wp ? " is-set" : ""}`}>
                  {wp ? <IconCheck size={11} /> : "空"}
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
