import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assetUrl } from "../lib/api";
import type { Wallpaper } from "../lib/types";
import { IconFolderMove, IconImage, IconMore, IconSearch, IconTrash } from "./icons";

interface Props {
  wallpapers: Wallpaper[];
  /** 当前屏已使用的壁纸 id，用于打角标 */
  activeIds: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onApply: (wallpaper: Wallpaper) => void;
  onDelete: (wallpaper: Wallpaper) => void;
  onMove: (wallpaper: Wallpaper) => void;
  onImport: () => void;
  /** 打开「添加本机文件夹」 */
  onImportFolder: () => void;
  importing: boolean;
  /** 当前筛选范围的标题，如「壁纸库」「风景（含子集）」 */
  scopeTitle: string;
  /** 范围副标题，说明这个范围里包含了什么 */
  scopeHint: string;
  /** 导入按钮文案随范围变化，让用户知道会导到哪里 */
  importLabel: string;
}

/**
 * 壁纸网格。
 *
 * 交互取舍：单击=设为壁纸（最高频动作，不该藏在二级菜单），
 * 拖拽=精确投放，更多菜单=归类与移除。这样 90% 的使用是零点击成本。
 */
export function WallpaperGrid({
  wallpapers,
  activeIds,
  onDragStart,
  onDragEnd,
  onApply,
  onDelete,
  onMove,
  onImport,
  onImportFolder,
  importing,
  scopeTitle,
  scopeHint,
  importLabel,
}: Props) {
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 菜单锚点：触发按钮的视口坐标 */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setAnchor(null);
  }, []);

  /**
   * 收起菜单的时机。
   *
   * 用 `pointerdown` 而不是 `click`：在卡片上按下鼠标时就要关，
   * 否则会出现「点在菜单外面，但卡片先响应了 click 把壁纸设了」的误操作。
   * 菜单自身内部通过 stopPropagation 豁免。
   */
  useEffect(() => {
    if (!menuFor) return;
    const onDown = () => closeMenu();
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuFor, closeMenu]);

  // 滚动或窗口尺寸变化会让锚点坐标失效，直接关掉比跟着错位更不容易看错
  useEffect(() => {
    if (!menuFor) return;
    const onScroll = (e: Event) => {
      // 菜单内部的滚动不应导致关闭（菜单本身不滚动，这里防御性地排除）
      if ((e.target as HTMLElement)?.closest?.(".card-menu")) return;
      closeMenu();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menuFor, closeMenu]);

  useEffect(() => {
    if (!menuFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuFor, closeMenu]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return wallpapers;
    return wallpapers.filter((w) => w.name.toLowerCase().includes(q));
  }, [wallpapers, query]);

  const menuWallpaper = wallpapers.find((w) => w.id === menuFor) ?? null;

  const openMenu = (w: Wallpaper, btn: HTMLElement) => {
    const r = btn.getBoundingClientRect();
    // 锚点用按钮的**右下角**：菜单默认向左下展开，
    // 这样右边缘与按钮对齐，视觉上像是从按钮「长出来」的。
    setAnchor({ x: r.right, y: r.bottom });
    setMenuFor((cur) => (cur === w.id ? null : w.id));
  };

  return (
    <section className="library">
      <header className="library-head">
        <div className="library-title-wrap">
          <div className="library-title">
            <h2>{scopeTitle}</h2>
            <span className="count">{wallpapers.length}</span>
          </div>
          <p className="library-sub">{scopeHint}</p>
        </div>
        <div className="library-tools">
          <label className="search">
            <IconSearch size={13} />
            <input
              placeholder="搜索名称"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button
            className="ghost"
            onClick={onImportFolder}
            disabled={importing}
            title="选择一个本机文件夹，扫描其中的图片"
          >
            <IconFolderMove size={13} />
            添加文件夹
          </button>
          <button className="primary" onClick={onImport} disabled={importing}>
            {importing ? "导入中…" : importLabel}
          </button>
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="library-empty">
          {wallpapers.length === 0 ? (
            <>
              <span className="empty-art" aria-hidden>
                <EmptyArt />
              </span>
              <p className="empty-title">{query ? "没有匹配的壁纸" : "这里还没有壁纸"}</p>
              <p className="hint">
                导入的图片会复制一份到库目录，之后删除原始文件也不影响使用。
                支持 JPG、PNG、WebP、BMP、GIF、TIFF、AVIF。
              </p>
              <div className="empty-actions">
                <button className="primary" onClick={onImport} disabled={importing}>
                  {importLabel}
                </button>
                <button className="ghost" onClick={onImportFolder} disabled={importing}>
                  <IconFolderMove size={13} />
                  添加本机文件夹
                </button>
              </div>
            </>
          ) : (
            <p className="hint">没有匹配「{query}」的壁纸</p>
          )}
        </div>
      ) : (
        <div className="grid" role="list">
          {filtered.map((w) => {
            const active = activeIds.has(w.id);
            return (
              <figure
                key={w.id}
                role="listitem"
                className={`card${active ? " is-active" : ""}`}
                draggable
                onDragStart={(e) => {
                  // 同时设置两个格式：自定义类型供画布精确识别，text 供系统兜底
                  e.dataTransfer.setData("application/x-wallpaper-id", w.id);
                  e.dataTransfer.setData("text/plain", w.id);
                  e.dataTransfer.effectAllowed = "copy";
                  closeMenu();
                  onDragStart(w.id);
                }}
                onDragEnd={onDragEnd}
                onClick={() => onApply(w)}
                title={`${w.name} · ${w.width}×${w.height} · 点击设为壁纸`}
              >
                <div className="card-img">
                  <img
                    src={assetUrl(w.thumbPath)}
                    alt={w.name}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                  {active && <span className="badge">使用中</span>}
                  <button
                    className="card-more"
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={menuFor === w.id}
                    onPointerDown={(e) => {
                      // 阻止冒泡到 window 的关闭监听，否则菜单刚开就被关掉
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      openMenu(w, e.currentTarget);
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                </div>
                <figcaption>
                  <span className="card-name">{w.name}</span>
                  <span className="card-meta">
                    {w.width}×{w.height}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      {/*
        菜单渲染到 body 上。
        卡片有 `overflow: hidden`（裁掉图片圆角），而菜单是它的子元素，
        一旦被裁就会「只剩左上角一小块」，无论 z-index 调多高都没用——
        overflow 的裁切发生在绘制阶段，早于层叠顺序比较。
        Portal 出去彻底脱离裁切祖先，也不必再和相邻卡片抢层级。
      */}
      {menuWallpaper &&
        anchor &&
        createPortal(
          <CardMenu
            anchor={anchor}
            onApply={() => {
              onApply(menuWallpaper);
              closeMenu();
            }}
            onMove={() => {
              onMove(menuWallpaper);
              closeMenu();
            }}
            onDelete={() => {
              onDelete(menuWallpaper);
              closeMenu();
            }}
          />,
          document.body,
        )}
    </section>
  );
}

/** 菜单本体：按锚点定位，并在贴近视口边缘时翻转方向。 */
function CardMenu({
  anchor,
  onApply,
  onMove,
  onDelete,
}: {
  anchor: { x: number; y: number };
  onApply: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    right: window.innerWidth - anchor.x,
    top: anchor.y + 4,
    visibility: "hidden",
  });

  // 先渲染再量尺寸，保证长菜单不会超出视口底部
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;

    let top = anchor.y + 4;
    if (top + height > window.innerHeight - margin) {
      // 下方放不下就向上翻，对齐到锚点上方
      top = Math.max(margin, anchor.y - height - 4);
    }
    let right = window.innerWidth - anchor.x;
    if (window.innerWidth - right < margin) right = margin;

    setStyle({ top, right, width: Math.max(width, 136), visibility: "visible" });
  }, [anchor]);

  return (
    <div
      ref={ref}
      className="card-menu"
      role="menu"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button role="menuitem" onClick={onApply}>
        <IconImage size={13} />
        设为壁纸
      </button>
      <button role="menuitem" onClick={onMove}>
        <IconFolderMove size={13} />
        移到合集…
      </button>
      <button role="menuitem" className="danger" onClick={onDelete}>
        <IconTrash size={13} />
        从库中移除
      </button>
    </div>
  );
}

/** 空库插画：几张错落的相框，比一句「暂无数据」更能提示该做什么。 */
function EmptyArt() {
  return (
    <svg width="76" height="58" viewBox="0 0 76 58" fill="none">
      <rect
        x="6.5"
        y="12.5"
        width="34"
        height="26"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.4"
      />
      <rect
        x="20.5"
        y="21.5"
        width="34"
        height="26"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.62"
      />
      <rect
        x="35.5"
        y="5.5"
        width="34"
        height="26"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.85"
      />
      <circle cx="45" cy="14" r="2.4" stroke="currentColor" strokeWidth="1.3" opacity="0.85" />
      <path
        d="M36.5 26l7.4-6.6a2 2 0 0 1 2.7 0l3.4 3.1M53 24l4.2-3.7a2 2 0 0 1 2.7 0l8.6 7.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

/** 把字节数转成易读文本，避免界面出现 123456789 这样的长串。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
