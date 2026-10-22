import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl } from "../lib/api";
import type { Monitor, Topology, Wallpaper } from "../lib/types";
import { monitorSize } from "../lib/types";

interface Props {
  topology: Topology | null;
  wallpaperMap: Map<string, Wallpaper>;
  selected: Set<string>;
  onToggleSelect: (identity: string, additive: boolean) => void;
  onDropWallpaper: (wallpaperId: string, identities: string[], applyAll: boolean) => void;
  /** 从壁纸库拖拽时携带的壁纸 id，由父组件在 dragstart 时写入 */
  draggingId: string | null;
}

const CANVAS_H = 236;
const PAD = 20;

/**
 * 显示器拓扑画布。
 *
 * 用真实显示器矩形等比缩放绘制，而不是画成等大的卡片。
 * 理由：用户对「哪块屏是哪块」的认知来自物理排列，
 * 三块屏尺寸悬殊时（3072×1920 + 竖屏 + 1080p），等大卡片反而让人分不清。
 *
 * 缩放时按包围盒整体等比，保证相对位置与系统显示设置完全一致。
 */
export function TopologyCanvas({
  topology,
  wallpaperMap,
  selected,
  onToggleSelect,
  onDropWallpaper,
  draggingId,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | "all" | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(720);

  // 画布宽度随窗口变化，重算缩放比
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setBoxW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!topology || topology.monitors.length === 0) return null;
    const b = topology.bounds;
    const bw = Math.max(1, b.right - b.left);
    const bh = Math.max(1, b.bottom - b.top);

    const availW = Math.max(200, boxW - PAD * 2);
    const availH = CANVAS_H - PAD * 2;
    // 取较小的缩放比，保证整体既不溢出宽也不溢出高
    const scale = Math.min(availW / bw, availH / bh);

    const offX = (boxW - bw * scale) / 2;
    const offY = (CANVAS_H - bh * scale) / 2;

    return topology.monitors.map((m) => ({
      monitor: m,
      left: offX + (m.rect.left - b.left) * scale,
      top: offY + (m.rect.top - b.top) * scale,
      width: Math.max(16, (m.rect.right - m.rect.left) * scale),
      height: Math.max(16, (m.rect.bottom - m.rect.top) * scale),
    }));
  }, [topology, boxW]);

  const handleDrop = useCallback(
    (monitor: Monitor, e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = e.dataTransfer.getData("application/x-wallpaper-id") || draggingId;
      if (!id) return;
      // 拖到画布上：若该屏已被选中且选中数 >1，则按选中的应用；否则只作用于该屏
      const targets = selected.has(monitor.identity) && selected.size > 1
        ? Array.from(selected)
        : [monitor.identity];
      onDropWallpaper(id, targets, false);
    },
    [draggingId, onDropWallpaper, selected],
  );

  if (!topology) {
    return (
      <div className="canvas-empty" ref={boxRef}>
        <span>正在读取显示器信息…</span>
      </div>
    );
  }

  if (topology.monitors.length === 0) {
    return (
      <div className="canvas-empty" ref={boxRef}>
        <span>未检测到显示器</span>
      </div>
    );
  }

  return (
    <div className="canvas" ref={boxRef} style={{ height: CANVAS_H }}>
      {layout?.map(({ monitor, left, top, width, height }) => {
        const isSelected = selected.has(monitor.identity);
        const isHover = hover === monitor.identity;
        const isDragOver = dragOver === monitor.identity;
        const wp = wallpaperMap.get(monitor.identity);
        const { w, h } = monitorSize(monitor);

        return (
          <div
            key={monitor.identity}
            className={[
              "screen",
              isSelected ? "is-selected" : "",
              isHover ? "is-hover" : "",
              isDragOver ? "is-dragover" : "",
            ].join(" ")}
            style={{
              left,
              top,
              width,
              height,
              // 用真实壁纸做底色，让用户一眼看到当前状态
              backgroundImage: wp ? `url("${assetUrl(wp.filePath)}")` : undefined,
            }}
            onMouseEnter={() => setHover(monitor.identity)}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => onToggleSelect(monitor.identity, e.ctrlKey || e.metaKey)}
            onDragOver={(e) => {
              // 必须 preventDefault 才允许 drop
              e.preventDefault();
              setDragOver(monitor.identity);
            }}
            onDragLeave={() => setDragOver((d) => (d === monitor.identity ? null : d))}
            onDrop={(e) => handleDrop(monitor, e)}
            title={`${monitor.name} · ${w}×${h}`}
          >
            <div className="screen-shade" />
            <div className="screen-label">
              <span className="screen-name">{monitor.name}</span>
              <span className="screen-res">
                {w}×{h}
              </span>
            </div>
            {monitor.primary && <div className="screen-primary">主屏</div>}
            {monitor.kind === "virtual" && <div className="screen-virtual">虚拟</div>}
            {isSelected && <div className="screen-check">✓</div>}
          </div>
        );
      })}
    </div>
  );
}
