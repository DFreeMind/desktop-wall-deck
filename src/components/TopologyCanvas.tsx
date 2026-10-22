import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Monitor, ScreenWallpaper, Topology } from "../lib/types";
import { isPortrait, monitorAspect, monitorSize } from "../lib/types";

interface Props {
  topology: Topology | null;
  /** 每块屏当前实际展示的壁纸；没有条目表示该屏当前无壁纸 */
  wallpaperMap: Map<string, ScreenWallpaper>;
  selected: Set<string>;
  onToggleSelect: (identity: string, additive: boolean) => void;
  onDropWallpaper: (wallpaperId: string, identities: string[], applyAll: boolean) => void;
  /** 从壁纸库拖拽时携带的壁纸 id，由父组件在 dragstart 时写入 */
  draggingId: string | null;
  /** 点击未分配壁纸的屏幕：引导用户去选图 */
  onPickFor: (identity: string) => void;
}

const PAD = 26;
/** 画布高度上下限：低于 210 显示器缩得看不清，高于 400 会挤压下方壁纸库 */
const MIN_H = 210;
const MAX_H = 400;
/**
 * 单块显示器在画布上的最小高度。
 *
 * 低于这个值，屏名与分辨率两行字会重叠、空态提示也放不下。
 * 130 是实测「招牌文字 + 一行元信息」都不挤的下限。
 */
const MIN_SCREEN_H = 130;

/**
 * 显示器拓扑画布。
 *
 * 布局原则与系统「显示设置」保持一致：按真实 RECT 等比缩放，
 * 每块屏的宽高比来自其分辨率，竖屏就是竖的。
 * 这里绝不做「等高卡片」之类的美化作法——用户对屏的认知
 * 来自物理摆放，形状一旦失真，拖拽投放到哪块屏就得靠猜。
 */
export function TopologyCanvas({
  topology,
  wallpaperMap,
  selected,
  onToggleSelect,
  onDropWallpaper,
  draggingId,
  onPickFor,
}: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(800);

  // 画布宽度决定缩放比，窗口缩放时要重算
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

  /**
   * 画布高度。
   *
   * 关键约束：横向并排的显示器（本机就是 3 块成一排）包围盒很扁，
   * 若只按「铺满宽度」算高度，单块屏会被压到 100px 左右，
   * 名字、分辨率、空态提示全挤在一起。
   *
   * 因此反过来以「最矮的那块屏至少要有多高」为基准推画布高度：
   * 单屏高度 = 画布可用高 × (屏高 / 包围盒高)，要求它不低于 MIN_SCREEN_H，
   * 于是画布可用高 ≥ MIN_SCREEN_H × 包围盒高 / 屏高。
   */
  const canvasH = useMemo(() => {
    if (!topology || topology.monitors.length === 0) return MIN_H;
    const b = topology.bounds;
    const bh = Math.max(1, b.bottom - b.top);

    // 最矮的屏（按包围盒高归一）
    let minRatio = 1;
    for (const m of topology.monitors) {
      const h = Math.max(1, m.rect.bottom - m.rect.top);
      minRatio = Math.min(minRatio, h / bh);
    }
    const neededByShortest = (MIN_SCREEN_H / Math.max(0.05, minRatio)) + PAD * 2;

    return Math.round(Math.min(MAX_H, Math.max(MIN_H, neededByShortest)));
  }, [topology]);

  const layout = useMemo(() => {
    if (!topology || topology.monitors.length === 0) return null;
    const b = topology.bounds;
    const bw = Math.max(1, b.right - b.left);
    const bh = Math.max(1, b.bottom - b.top);

    const availW = Math.max(200, boxW - PAD * 2);
    const availH = canvasH - PAD * 2;
    // 取较小的缩放比，保证整体既不溢出宽也不溢出高
    const scale = Math.min(availW / bw, availH / bh);

    const offX = (boxW - bw * scale) / 2;
    const offY = (canvasH - bh * scale) / 2;

    return topology.monitors.map((m) => ({
      monitor: m,
      left: Math.round(offX + (m.rect.left - b.left) * scale),
      top: Math.round(offY + (m.rect.top - b.top) * scale),
      width: Math.round(Math.max(16, (m.rect.right - m.rect.left) * scale)),
      height: Math.round(Math.max(16, (m.rect.bottom - m.rect.top) * scale)),
    }));
  }, [topology, boxW, canvasH]);

  const handleDrop = useCallback(
    (monitor: Monitor, e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = e.dataTransfer.getData("application/x-wallpaper-id") || draggingId;
      if (!id) return;
      // 拖到画布上：若该屏已被选中且选中数 >1，则按选中的应用；否则只作用于该屏
      const targets =
        selected.has(monitor.identity) && selected.size > 1
          ? Array.from(selected)
          : [monitor.identity];
      onDropWallpaper(id, targets, false);
    },
    [draggingId, onDropWallpaper, selected],
  );

  if (!topology) {
    return (
      <div className="canvas-empty" ref={boxRef} style={{ height: MIN_H }}>
        <span>正在读取显示器信息…</span>
      </div>
    );
  }

  if (topology.monitors.length === 0) {
    return (
      <div className="canvas-empty" ref={boxRef} style={{ height: MIN_H }}>
        <span>未检测到显示器</span>
      </div>
    );
  }

  return (
    <div className="canvas" ref={boxRef} style={{ height: canvasH }}>
      {/* 坐标系底纹，暗示这是桌面的空间关系而不是普通容器 */}
      <div className="canvas-grid" aria-hidden />

      {layout?.map(({ monitor, left, top, width, height }) => {
        const isSelected = selected.has(monitor.identity);
        const isHover = hover === monitor.identity;
        const isDragOver = dragOver === monitor.identity;
        const sw = wallpaperMap.get(monitor.identity);
        // 只有真正拿到预览图才算「有壁纸」，否则仍按空屏渲染占位，
        // 避免出现「有壁纸但显示为空灰色块」的半吊子状态
        const hasImage = !!sw && sw.preview !== null;
        const isLibrary = sw?.kind === "library";
        const { w, h } = monitorSize(monitor);
        const tall = isPortrait(monitor);
        /** 屏幕太小时隐藏次级信息，否则文字会糊成一团 */
        const compact = width < 130 || height < 84;
        const tiny = width < 92 || height < 62;
        /**
         * 空屏提示（图形 + 「未设置」）只在高度充裕时显示。
         *
         * 底部常驻名称与分辨率两行，占了约 30px。居中提示若也画上，
         * 在 130px 高的屏里必然与标签叠在一起——两者都读不清。
         * 取舍：标签回答「这是哪块屏」，优先级更高；提示让位，
         * 用户把鼠标移上去时 title 仍会给出「未设置壁纸」。
         */
        const showBlankHint = height >= 168 && width >= 104;
        const showBlankGlyph = height >= 118 && width >= 96;

        return (
          <div
            key={monitor.identity}
            className={[
              "screen",
              isSelected ? "is-selected" : "",
              isHover ? "is-hover" : "",
              isDragOver ? "is-dragover" : "",
              hasImage ? "has-wallpaper" : "is-blank",
              compact ? "is-compact" : "",
              tiny ? "is-tiny" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left,
              top,
              width,
              height,
              // 壁纸用作底色，让用户一眼看到当前状态
              backgroundImage: hasImage ? `url("${sw!.preview}")` : undefined,
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
            title={`${monitor.name} · ${w}×${h}${
              !sw
                ? " · 未设置壁纸"
                : isLibrary
                  ? ` · ${sw.wallpaper.name}`
                  : " · 当前壁纸来自系统（不在库中）"
            }`}
          >
            {!hasImage && (
              <div className="screen-blank-inner">
                {showBlankGlyph && (
                  <span className="screen-blank-mark">
                    <BlankGlyph size={Math.min(34, height * 0.24)} />
                  </span>
                )}
                {showBlankHint ? (
                  <span className="screen-blank-text">
                    {sw ? "无预览" : "未设置"}
                    {!sw && (
                      <button
                        className="screen-blank-cta"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPickFor(monitor.identity);
                        }}
                      >
                        选一张
                      </button>
                    )}
                  </span>
                ) : (
                  /* 放不下按钮时给一句更短的水印，让空屏看起来是「有意的空」而非加载失败 */
                  !tiny && (
                    <span className="screen-blank-note" aria-hidden>
                      {sw ? "无预览" : "未设置"}
                    </span>
                  )
                )}
              </div>
            )}

            {hasImage && <div className="screen-shade" />}

            <div className="screen-label">
              <span className="screen-name">{monitor.name}</span>
              {!compact && (
                <span className="screen-res">
                  {w}×{h}
                  {tall ? " · 竖" : ""}
                </span>
              )}
            </div>
            {monitor.primary && <div className="screen-tag screen-tag-primary">主屏</div>}
            {monitor.kind === "virtual" && (
              <div className="screen-tag screen-tag-virtual">虚拟</div>
            )}
            {isSelected && (
              <div className="screen-check">
                <CheckMark />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 空屏占位图形：一台显示器的线稿，比纯色块更能传达「这里应该放点东西」。 */
function BlankGlyph({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * 0.86}
      viewBox="0 0 30 26"
      fill="none"
      aria-hidden
    >
      <rect
        x="1.2"
        y="1.2"
        width="27.6"
        height="19.2"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="3.4 2.6"
        opacity="0.5"
      />
      <path
        d="M11 24.2h8M15 20.4v3.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M15 8.2v6.4M12 11.4h6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 6.4l2.6 2.4L10 3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 供右侧面板复用的比例描述，避免两处各写一份判断逻辑。 */
export function describeMonitor(m: Monitor): string {
  const { w, h } = monitorSize(m);
  const parts = [`${w}×${h}`];
  const ratio = monitorAspect(m);
  if (ratio > 2.1) parts.push("超宽");
  else if (ratio < 0.85) parts.push("竖屏");
  if (m.primary) parts.push("主屏");
  if (m.kind === "virtual") parts.push("虚拟屏");
  return parts.join(" · ");
}
