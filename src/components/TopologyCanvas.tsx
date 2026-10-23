import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Monitor, Position, Wallpaper, ScreenWallpaper, Topology } from "../lib/types";
import { isPortrait, monitorAspect, monitorSize } from "../lib/types";
import type { WallpaperDragState } from "../hooks/useWallpaperDrag";
import { WallpaperDropFeedback } from "./WallpaperDropFeedback";

interface Props {
  topology: Topology | null;
  collapsed?: boolean;
  pendingWallpaper?: Wallpaper | null;
  position?: Position;
  /** 每块屏当前实际展示的壁纸；没有条目表示该屏当前无壁纸 */
  wallpaperMap: Map<string, ScreenWallpaper>;
  selected: Set<string>;
  onToggleSelect: (identity: string, additive: boolean) => void;
  drag: WallpaperDragState | null;
  externalTargetId?: string | null;
  /** 点击未分配壁纸的屏幕：引导用户去选图 */
  onPickFor: (identity: string) => void;
}

const PAD = 20;
/** 设置卡占用固定高度；画布在此基础上按空间自适应，最高 400px。 */
const MIN_H = 260;
const MAX_H = 400;

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
  collapsed = false,
  pendingWallpaper = null,
  position = "fill",
  externalTargetId = null,
  wallpaperMap,
  selected,
  onToggleSelect,
  drag,
  onPickFor,
}: Props) {
  const revision = useThumbnailRevision();
  const [hover, setHover] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(800);
  const [heightBudget, setHeightBudget] = useState(MAX_H);

  useEffect(() => {
    const page = boxRef.current?.closest<HTMLElement>(".display-page");
    if (!page) return;
    const libraryHead = page.querySelector<HTMLElement>(".gallery-controls");
    const canvasHead = page.querySelector<HTMLElement>(".canvas-head");
    const measure = () => {
      // 为一排固定高度的壁纸和工具栏留位；窗口较矮时按比例缩小画布，文字沿用既有降级规则。
      const reserved = 210 + (libraryHead?.getBoundingClientRect().height ?? 48) + (canvasHead?.getBoundingClientRect().height ?? 30) + 88;
      setHeightBudget(Math.max(140, Math.min(MAX_H, Math.floor(page.clientHeight - reserved))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    if (libraryHead) observer.observe(libraryHead);
    if (canvasHead) observer.observe(canvasHead);
    return () => observer.disconnect();
  }, []);

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

  // 用整组屏幕的包围盒计算最佳高度；屏幕数量与排列变化后自动重新适配。
  const canvasH = useMemo(() => {
    if (collapsed) return 100;
    if (!topology || !topology.monitors.length) return MIN_H;
    const bw = Math.max(1, topology.bounds.right - topology.bounds.left);
    const bh = Math.max(1, topology.bounds.bottom - topology.bounds.top);
    const widthFitHeight = Math.max(1, boxW - PAD * 2) / bw * bh + PAD * 2;
    return Math.max(MIN_H, Math.min(MAX_H, heightBudget, Math.ceil(widthFitHeight)));
  }, [topology, collapsed, boxW, heightBudget]);
  const stageW = boxW;
  const stageH = canvasH - 2;

  const layout = useMemo(() => {
    if (!topology || topology.monitors.length === 0) return null;
    const b = topology.bounds;
    const bw = Math.max(1, b.right - b.left);
    const bh = Math.max(1, b.bottom - b.top);

    const padding = collapsed ? 8 : PAD;
    const availW = Math.max(1, stageW - padding * 2);
    const availH = Math.max(1, stageH - padding * 2);
    // 取较小的缩放比，保证整体既不溢出宽也不溢出高
    const scale = Math.min(availW / bw, availH / bh);

    const offX = (stageW - bw * scale) / 2;
    const offY = (stageH - bh * scale) / 2;

    return topology.monitors.map((m) => ({
      monitor: m,
      left: Math.round(offX + (m.rect.left - b.left) * scale),
      top: Math.round(offY + (m.rect.top - b.top) * scale),
      width: Math.round(Math.max(1, (m.rect.right - m.rect.left) * scale)),
      height: Math.round(Math.max(1, (m.rect.bottom - m.rect.top) * scale)),
    }));
  }, [topology, stageW, stageH, collapsed]);

  if (!topology) {
    return (
      <div className="canvas-empty" ref={boxRef} style={{ height: canvasH }}>
        <span>正在读取显示器信息…</span>
      </div>
    );
  }

  if (topology.monitors.length === 0) {
    return (
      <div className="canvas-empty" ref={boxRef} style={{ height: canvasH }}>
        <span>未检测到显示器</span>
      </div>
    );
  }

  return (
    <div className="canvas is-overview" ref={boxRef} style={{ height: canvasH }} aria-label="显示器布局，按实际排列自动适配全部屏幕">
      <div className="canvas-stage" style={{ width: stageW, height: stageH }}>
      {/* 坐标系底纹，暗示这是桌面的空间关系而不是普通容器 */}
      <div className="canvas-grid" aria-hidden />

      {layout?.map(({ monitor, left, top, width, height }, index) => {
        const isSelected = selected.has(monitor.identity);
        const isHover = hover === monitor.identity;
        const isDropTarget = !!drag?.targetIds.includes(monitor.identity);
        const currentWallpaper = wallpaperMap.get(monitor.identity);
        const previewPending = isSelected && !!pendingWallpaper && !pendingWallpaper.missing && position !== "tile";
        const changed = previewPending && (currentWallpaper?.kind !== "library" || currentWallpaper.wallpaper.id !== pendingWallpaper.id);
        const sw: ScreenWallpaper | undefined = previewPending
          ? { kind: "library", wallpaper: pendingWallpaper, preview: assetUrl(pendingWallpaper.thumbPath, thumbnailVersion(revision, pendingWallpaper.id)) }
          : currentWallpaper;
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
              externalTargetId === monitor.identity ? "is-external-drop-target" : "",
              drag?.phase === "dragging" ? "is-drop-ready" : "",
              isDropTarget ? `is-drop-target is-drop-${drag!.phase}` : "",
              drag?.phase === "dragging" && drag.targetIds.length && !isDropTarget ? "is-drop-muted" : "",
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
              backgroundSize: previewPending ? position === "fit" ? "contain" : position === "stretch" ? "100% 100%" : position === "center" ? `${pendingWallpaper!.width * width / w}px ${pendingWallpaper!.height * height / h}px` : "cover" : undefined,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center",
              backgroundImage: hasImage ? `url("${sw!.preview}")` : undefined,
            }}
            role="button" tabIndex={0} aria-pressed={isSelected}
            onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onToggleSelect(monitor.identity, e.ctrlKey || e.metaKey); } }}
            onMouseEnter={() => setHover(monitor.identity)}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => onToggleSelect(monitor.identity, e.ctrlKey || e.metaKey)}
            data-wallpaper-drop-target={monitor.identity}
            title={`${monitor.name} · ${w}×${h}${
              !sw
                ? " · 未设置壁纸"
                : isLibrary
                  ? ` · ${sw.wallpaper.name}`
                  : " · 当前壁纸来自系统（不在库中）"
            }`}
          >
            {externalTargetId === monitor.identity && <div className="screen-external-drop-note"><span>松开，仅设置到此屏</span></div>}
            <WallpaperDropFeedback drag={drag} identity={monitor.identity} small={height < 105} />
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
            <span className="screen-number" title="本次检测的显示器编号">{index + 1}</span>
            {changed && <span className="screen-pending-tag">待应用</span>}

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
