import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { OnlineSearchResult, OnlineWallpaper } from "../lib/types";
import { WALLPAPER_SOURCES, type WallpaperSource } from "../lib/wallpaperSources";
import { IconCheck, IconExternal, IconGlobe, IconPlus, IconRefresh, IconSearch } from "../components/icons";

interface Props {
  onOpenExternal: (url: string) => void;
  onImport: (item: OnlineWallpaper, apply: boolean) => Promise<void>;
  targetLabel: string;
  onSelectTargets: () => void;
}

// 缓存请求本身，同时合并 StrictMode 与重复切换来源产生的并发请求。
const requests = new Map<string, { time: number; result: Promise<OnlineSearchResult> }>();
function search(source: string, query: string, page: number, force: boolean) {
  const key = JSON.stringify([source, query, page]);
  const cached = requests.get(key);
  if (!force && cached && Date.now() - cached.time < 5 * 60_000) return cached.result;
  const result = api.onlineSearch(source, query, page);
  if (requests.size >= 64) requests.delete(requests.keys().next().value!);
  requests.set(key, { time: Date.now(), result });
  // 防止旧请求失败时清掉更新的重试请求。
  void result.catch(() => { if (requests.get(key)?.result === result) requests.delete(key); });
  return result;
}

export function SourcesView(props: Props) {
  const [activeId, setActiveId] = useState("wallhaven");
  const active = WALLPAPER_SOURCES.find((s) => s.id === activeId)!;
  return (
    <div className="page page-flush sources-page">
      <header className="page-head">
        <div><h1>发现壁纸</h1><p className="page-sub">从在线图库挑选喜欢的图片，加入壁纸库后即可离线使用。</p></div>
        <button className="ghost small" onClick={props.onSelectTargets}>应用目标：{props.targetLabel}</button>
      </header>
      <nav className="source-tabs" aria-label="壁纸来源">
        {WALLPAPER_SOURCES.filter((s) => s.online).map((s) => (
          <button key={s.id} className={`source-tab${s.id === activeId ? " is-active" : ""}`}
            aria-pressed={s.id === activeId} onClick={() => setActiveId(s.id)}><IconGlobe size={14} />{s.name}</button>
        ))}
        <span className="source-tabs-divider" />
        {WALLPAPER_SOURCES.filter((s) => !s.online).map((s) => (
          <button key={s.id} className={`source-tab source-tab-extra${s.id === activeId ? " is-active" : ""}`}
            aria-pressed={s.id === activeId} onClick={() => setActiveId(s.id)}>{s.name}<IconExternal size={11} /></button>
        ))}
      </nav>
      {active.online ? <SourceResults key={active.id} source={active} {...props} /> : (
        <div className="online-empty">
          <IconGlobe size={30} /><h2>{active.name}</h2><p>{active.blurb}</p>
          <button className="primary" onClick={() => props.onOpenExternal(active.home)}><IconExternal size={14} />前往官网</button>
          <button className="ghost" onClick={() => setActiveId("wallhaven")}>浏览已接入的在线壁纸</button>
        </div>
      )}
    </div>
  );
}

function SourceResults({ source, onOpenExternal, onImport }: Props & { source: WallpaperSource }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<OnlineWallpaper[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [imported, setImported] = useState(new Set<string>());
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);

  async function load(nextPage: number, force = false) {
    const ticket = ++requestId.current;
    setLoading(true); setError(null);
    try {
      const result = await search(source.id, query, nextPage, force);
      if (ticket !== requestId.current) return;
      setItems((previous) => nextPage === 1 ? result.items : [...previous, ...result.items.filter((i) => !previous.some((p) => p.id === i.id))]);
      setPage(result.page); setHasMore(result.hasMore);
    } catch (e) {
      if (ticket === requestId.current) setError((e as Error).message);
    } finally { if (ticket === requestId.current) setLoading(false); }
  }

  useEffect(() => {
    setItems([]); setPage(0); setHasMore(false);
    void load(1, revision > 0);
    return () => { requestId.current++; };
  }, [source.id, query, revision]);

  async function importItem(item: OnlineWallpaper, apply: boolean) {
    if (busyRef.current) return;
    busyRef.current = true; setBusyId(item.id); setImportError(null);
    try {
      await onImport(item, apply);
      if (mounted.current) setImported((s) => new Set([...s, item.id]));
    } catch (e) { if (mounted.current) setImportError((e as Error).message); }
    finally { busyRef.current = false; if (mounted.current) setBusyId(null); }
  }

  return <>
    <div className="online-toolbar">
      <form className="online-search" onSubmit={(e) => { e.preventDefault(); const next = input.trim(); if (next === query) setRevision((r) => r + 1); else setQuery(next); }}>
        <label className="search"><IconSearch size={14} /><input aria-label="搜索在线壁纸" placeholder={`搜索 ${source.name}，如 mountains、forest…`} value={input} onChange={(e) => setInput(e.target.value)} maxLength={160} /></label>
        <button className="primary" type="submit">搜索</button>
      </form>
      <button className="icon-text-btn" disabled={loading} onClick={() => setRevision((r) => r + 1)}><IconRefresh size={14} />刷新壁纸</button>
      <button className="icon-text-btn" onClick={() => onOpenExternal(source.home)}><IconExternal size={13} />来源官网</button>
    </div>
    <p className="online-description">{source.blurb}</p>
    {importError && <div className="online-error" role="alert">{importError}<button className="link-btn" onClick={() => setImportError(null)}>关闭</button></div>}
    <div className="online-scroll" aria-busy={loading}>
      {loading && items.length === 0 && <div className="online-empty" role="status"><span className="spinner" /><p>正在加载 {source.name} 的壁纸…</p></div>}
      {!loading && !error && items.length === 0 && <div className="online-empty"><IconSearch size={26} /><h2>没有找到相关图片</h2><p>试试其他关键词；Wallhaven 和 NASA 建议用英文搜索。</p></div>}
      <div className="online-grid">
        {items.map((item) => <article className="online-card" key={item.id}>
          <button className="online-image" onClick={() => onOpenExternal(item.pageUrl)} title="查看原图与许可">
            <img src={item.thumbnailUrl} alt={item.title} loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.visibility = "hidden"; e.currentTarget.parentElement!.dataset.failed = "true"; }} />
            <span className="online-image-note">查看原图</span>
            <span className="online-resolution">{item.width > 0 ? `${item.width} × ${item.height}` : "NASA 影像"}</span>
          </button>
          <div className="online-card-body">
            <h2 title={item.title}>{item.title}</h2>
            <p className="online-credit" title={item.author}>{item.author || source.name}</p>
            <p className="online-license" title={item.license}>{item.license}</p>
            <div className="online-card-actions">
              <button className="ghost small" disabled={!!busyId || imported.has(item.id)} onClick={() => void importItem(item, false)}>
                {imported.has(item.id) ? <IconCheck size={12} /> : <IconPlus size={12} />}{imported.has(item.id) ? "已加入" : busyId === item.id ? "下载中…" : "加入壁纸库"}
              </button>
              <button className="primary small" disabled={!!busyId} onClick={() => void importItem(item, true)}>设为壁纸</button>
            </div>
          </div>
        </article>)}
      </div>
      {error && <div className="online-empty online-load-error" role="alert"><h2>暂时无法加载 {source.name}</h2><p>{error}</p><button className="ghost" onClick={() => void load(page + 1, true)}>重新加载</button><p>也可以切换上方其他来源。</p></div>}
      {items.length > 0 && !error && <div className="online-pagination">
        {hasMore ? <button className="ghost" disabled={loading} onClick={() => void load(page + 1)}>{loading ? "正在加载…" : "加载更多壁纸"}</button> : <span>已展示全部 {items.length} 张图片</span>}
      </div>}
    </div>
    <p className="sources-hint">图片按需下载到本地壁纸库。{source.license}，作者与许可随图片来源信息保存。</p>
  </>;
}
