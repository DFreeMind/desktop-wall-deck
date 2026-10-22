import { useEffect, useMemo, useState } from "react";
import { assetUrl } from "../lib/api";
import type { Wallpaper } from "../lib/types";
import { IconFolderMove, IconMore, IconSearch, IconTrash } from "./icons";

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
  importing,
  scopeTitle,
  scopeHint,
  importLabel,
}: Props) {
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // 点击空白处收起菜单，否则菜单会一直挂在屏幕上
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return wallpapers;
    return wallpapers.filter((w) => w.name.toLowerCase().includes(q));
  }, [wallpapers, query]);

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
              <button className="primary" onClick={onImport} disabled={importing}>
                {importLabel}
              </button>
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
                    draggable={false}
                  />
                  {active && <span className="badge">使用中</span>}
                  <button
                    className="card-more"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setMenuFor((cur) => (cur === w.id ? null : w.id));
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

                {menuFor === w.id && (
                  <div className="card-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => {
                        onApply(w);
                        setMenuFor(null);
                      }}
                    >
                      设为壁纸
                    </button>
                    <button
                      onClick={() => {
                        onMove(w);
                        setMenuFor(null);
                      }}
                    >
                      <IconFolderMove size={13} />
                      移到合集…
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        onDelete(w);
                        setMenuFor(null);
                      }}
                    >
                      <IconTrash size={13} />
                      从库中移除
                    </button>
                  </div>
                )}
              </figure>
            );
          })}
        </div>
      )}
    </section>
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
