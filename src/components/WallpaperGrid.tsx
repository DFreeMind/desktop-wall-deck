import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import type { Wallpaper } from "../lib/types";
import { IconChevron, IconSort, IconPlus, IconHeart, IconGrid, IconList, IconExpand, IconFolderMove, IconImage, IconMore, IconRefresh, IconSearch, IconTrash } from "./icons";

interface Props {
  wallpapers: Wallpaper[];
  /** 当前屏已使用的壁纸 id，用于打角标 */
  activeIds: Set<string>;
  screenLabels?: Map<string, string[]>;
  selectedId: string | null;
  draggingId: string | null;
  onPointerDrag: (wallpaper: Wallpaper, event: React.PointerEvent<HTMLElement>) => void;
  onSelect: (wallpaper: Wallpaper, toggle?: boolean) => void;
  onPreview: (wallpaper: Wallpaper) => void;
  onDetails: (wallpaper: Wallpaper) => void;
  onRelink: (wallpaper: Wallpaper) => void;
  onRefresh: () => void;
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
  filters?: React.ReactNode;
}

/**
 * 壁纸网格。
 *
 * 单击只选择并预览，应用动作在显示器面板明确执行。
 * 拖拽到指定屏幕仍属于显式投放；更多菜单负责归类与移除。
 */
export function WallpaperGrid({
  wallpapers,
  activeIds,
  screenLabels,
  selectedId,
  draggingId,
  onPointerDrag,
  onSelect,
  onPreview,
  onDetails,
  onRelink,
  onRefresh,
  onDelete,
  onMove,
  onImport,
  onImportFolder,
  importing,
  scopeTitle,
  importLabel,
  filters,
}: Props) {
  const reduced = useReducedMotion();
  const thumbnailRevision = useThumbnailRevision();
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { const ids: unknown = JSON.parse(localStorage.getItem("wall-deck.favorites.v1") ?? "[]"); return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []); } catch { return new Set(); }
  });
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [favoriteError, setFavoriteError] = useState(false);
  const toggleFavorite = (id: string) => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem("wall-deck.favorites.v1", JSON.stringify([...next])); setFavoriteError(false); } catch { setFavoriteError(true); }
    setFavorites(next);
  };
  const [sort, setSort] = useState("recent");
  const [listView, setListView] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [addPosition, setAddPosition] = useState({ top: 0, right: 0 });
  useLayoutEffect(() => {
    if (!addOpen) return;
    const place = () => {
      const rect = addRef.current!.getBoundingClientRect();
      setAddPosition({ top: Math.min(rect.bottom + 6, window.innerHeight - 112), right: Math.max(12, window.innerWidth - rect.right) });
    };
    place();
    addMenuRef.current?.querySelector('button')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!addRef.current?.contains(event.target as Node) && !addMenuRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setAddOpen(false); addRef.current?.focus(); }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", key, true); window.removeEventListener("resize", place); };
  }, [addOpen]);
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
    const items = wallpapers.filter((w) => (!onlyFavorites || favorites.has(w.id)) && (!q || w.name.toLowerCase().includes(q)));
    return items.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "size" ? b.width * b.height - a.width * a.height : b.createdAt - a.createdAt);
  }, [wallpapers, query, sort, onlyFavorites, favorites]);

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
      <div className="gallery-controls">
      <header className="library-head">
        <div className="library-title-wrap">
          <div className="library-title">
            <h2>{scopeTitle}</h2>
            <span className="count">{filtered.length} 张壁纸</span>
          </div>
        </div>
        <div className="library-tools">
          <button className="icon-plain" title="刷新本地图片索引" onClick={onRefresh} disabled={importing}><IconRefresh size={15} /></button>
          <label className="search">
            <IconSearch size={13} />
            <input
              placeholder="搜索壁纸名称…"
              aria-label="搜索壁纸名称"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="gallery-add">
            <button className="primary" onClick={onImport} disabled={importing} title={importLabel}><IconPlus size={16} />{importing ? "添加中…" : "添加壁纸"}</button>
            <button ref={addRef} className="primary gallery-add-toggle" aria-label="展开添加菜单" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)} disabled={importing}><IconChevron size={14} /></button>
          </div>
        </div>
      </header>
      <div className="gallery-toolbar">
        {filters}
        <button className="gallery-favorite-filter" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(!onlyFavorites)} title="筛选当前目录的收藏"><IconHeart size={15} />已收藏</button>
        <div className="gallery-view-tools">
          <label className="gallery-sort"><IconSort size={16} /><select aria-label="壁纸排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近添加</option><option value="name">名称排序</option><option value="size">图片分辨率</option></select></label>
          <div className="gallery-view-switch" aria-label="图库视图">
            <button aria-label="网格视图" aria-pressed={!listView} onClick={() => setListView(false)}><IconGrid size={16} /></button>
            <button aria-label="列表视图" aria-pressed={listView} onClick={() => setListView(true)}><IconList size={16} /></button>
          </div>
        </div>
      </div>
      </div>
      {addOpen && createPortal(<div ref={addMenuRef} className="gallery-add-menu" role="menu" style={addPosition} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll('button')); const i = items.indexOf(document.activeElement as HTMLButtonElement); items[(i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
        if (event.key === "Tab") setAddOpen(false);
      }}><button role="menuitem" onClick={() => { setAddOpen(false); addRef.current?.focus(); onImport(); }}><IconImage size={16} />添加图片</button><button role="menuitem" onClick={() => { setAddOpen(false); addRef.current?.focus(); onImportFolder(); }}><IconFolderMove size={16} />添加文件夹</button></div>, document.body)}

      {favoriteError && <p role="status" className="hint">收藏已在本次会话生效，但未能保存到本机。请检查浏览器存储权限。</p>}
      {filtered.length === 0 ? (
        <div className="library-empty">
          {wallpapers.length === 0 ? (
            <>
              <span className="empty-art" aria-hidden>
                <EmptyArt />
              </span>
              <p className="empty-title">{query ? "没有匹配的壁纸" : "这里还没有壁纸"}</p>
              <p className="hint">
                添加本机图片或文件夹，只建立索引，不复制或修改原文件。
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
            <p className="hint">{onlyFavorites && !query ? "当前目录还没有收藏的壁纸" : `没有匹配「${query}」的壁纸`}</p>
          )}
        </div>
      ) : (
        <div className={`grid${listView ? " is-list-view" : ""}`} role="list">
          {filtered.map((w, index) => {
            const active = activeIds.has(w.id);
            return (
              <m.figure
                key={w.id}
                initial={index < 12 ? { opacity: 0, y: reduced ? 0 : 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduced ? 0 : .24, delay: reduced ? 0 : Math.min(index, 7) * .018, ease: [.22, 1, .36, 1] }}
                role="listitem"
                className={`card${active ? " is-active" : ""}${selectedId === w.id ? " is-selected" : ""}${draggingId === w.id ? " is-wallpaper-dragging" : ""}`}
                tabIndex={0}
                aria-current={selectedId === w.id ? "true" : undefined}
                data-source-missing={w.missing || undefined}
                data-wallpaper-id={w.id}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => { closeMenu(); onPointerDrag(w, event); }}
                onClick={() => onSelect(w, true)}
                onDoubleClick={() => onPreview(w)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(w, true);
                  }
                }}
                title={`${w.name} · ${w.width}×${w.height} · 单击选择或取消选择，双击查看大图；拖到显示器可直接设置`}
              >
                {selectedId === w.id && <m.span className="card-selection-ring" layoutId={`wallpaper-selection-${scopeTitle}`} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 440, damping: 38 }} />}
                <div className="card-img">
                  <img
                    src={assetUrl(w.thumbPath, thumbnailVersion(thumbnailRevision, w.id))}
                    alt={w.name}
                    loading={index < 8 ? "eager" : "lazy"}
                    decoding="async"
                    draggable={false}
                  />
                  {active && <div className="card-usage"><span className="badge">使用中</span>{screenLabels?.get(w.id)?.length ? <span className="card-screen-label" title={screenLabels.get(w.id)!.join("、")}>{screenLabels.get(w.id)!.join(" · ")}</span> : null}</div>}
                  <span className="card-resolution">{w.width} × {w.height}</span>
                  {w.missing && <span className="badge source-missing">原文件不可用</span>}
                  <button className={`card-favorite${favorites.has(w.id) ? " is-favorite" : ""}`} aria-label={`${favorites.has(w.id) ? "取消收藏" : "收藏"}：${w.name}`} aria-pressed={favorites.has(w.id)} title={favorites.has(w.id) ? "取消收藏" : "收藏"} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); toggleFavorite(w.id); }}><IconHeart size={18} /></button>
                  <button className="card-preview" title={`查看大图：${w.name}`} onClick={(e) => { e.stopPropagation(); onPreview(w); }} onDoubleClick={(e) => e.stopPropagation()}>
                    <IconExpand size={14} />
                  </button>

                </div>
                <figcaption>
                  <span className="card-name">{w.name}</span>
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
                </figcaption>
              </m.figure>
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
            onSelect={() => {
              onSelect(menuWallpaper);
              closeMenu();
            }}
            onPreview={() => { onPreview(menuWallpaper); closeMenu(); }}
            onDetails={() => { onDetails(menuWallpaper); closeMenu(); }}
            onRelink={menuWallpaper.storageKind === "indexed" ? () => { onRelink(menuWallpaper); closeMenu(); } : undefined}
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
  onSelect,
  onPreview,
  onDetails,
  onRelink,
  onMove,
  onDelete,
}: {
  anchor: { x: number; y: number };
  onSelect: () => void;
  onPreview: () => void;
  onDetails: () => void;
  onRelink?: () => void;
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
      <button role="menuitem" onClick={onPreview}><IconExpand size={13} />查看大图</button>
      <button role="menuitem" onClick={onDetails}><IconImage size={13} />图片详情</button>
      {onRelink && <button role="menuitem" onClick={onRelink}><IconFolderMove size={13} />重新定位原文件…</button>}
      <button role="menuitem" onClick={onSelect}>
        <IconImage size={13} />
        选择并预览
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
