import { useMemo, useState } from "react";
import { assetUrl } from "../lib/api";
import type { Wallpaper } from "../lib/types";

interface Props {
  wallpapers: Wallpaper[];
  /** 当前屏已使用的壁纸 id，用于打角标 */
  activeIds: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onApply: (wallpaper: Wallpaper) => void;
  onDelete: (wallpaper: Wallpaper) => void;
  onImport: () => void;
  importing: boolean;
}

/**
 * 壁纸库网格。
 *
 * 交互取舍：单击=设为壁纸（最高频动作，不该藏在二级菜单），
 * 拖拽=精确投放，右键=更多操作。这样 90% 的使用是零点击成本。
 */
export function WallpaperGrid({
  wallpapers,
  activeIds,
  onDragStart,
  onDragEnd,
  onApply,
  onDelete,
  onImport,
  importing,
}: Props) {
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return wallpapers;
    return wallpapers.filter((w) => w.name.toLowerCase().includes(q));
  }, [wallpapers, query]);

  return (
    <section className="library">
      <header className="library-head">
        <div className="library-title">
          壁纸库
          <span className="count">{wallpapers.length}</span>
        </div>
        <div className="library-tools">
          <input
            className="search"
            placeholder="搜索名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button onClick={onImport} disabled={importing}>
            {importing ? "导入中…" : "导入图片"}
          </button>
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="library-empty">
          {wallpapers.length === 0 ? (
            <>
              <p>壁纸库还是空的</p>
              <p className="hint">
                点击「导入图片」添加本地图片，导入后会复制一份到库目录，原文件删除也不影响
              </p>
              <button className="primary" onClick={onImport} disabled={importing}>
                导入图片
              </button>
            </>
          ) : (
            <p className="hint">没有匹配「{query}」的壁纸</p>
          )}
        </div>
      ) : (
        <div className="grid">
          {filtered.map((w) => {
            const active = activeIds.has(w.id);
            return (
              <figure
                key={w.id}
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor((cur) => (cur === w.id ? null : w.id));
                }}
                title={`${w.name} · ${w.width}×${w.height}`}
              >
                <div className="card-img">
                  <img src={assetUrl(w.thumbPath)} alt={w.name} loading="lazy" draggable={false} />
                  {active && <span className="badge">使用中</span>}
                </div>
                <figcaption>
                  <span className="card-name">{w.name}</span>
                  <span className="card-meta">
                    {w.width}×{w.height}
                  </span>
                </figcaption>

                {menuFor === w.id && (
                  <div className="card-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { onApply(w); setMenuFor(null); }}>应用</button>
                    <button
                      className="danger"
                      onClick={() => { onDelete(w); setMenuFor(null); }}
                    >
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

/** 把字节数转成易读文本，避免界面出现 123456789 这样的长串。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
