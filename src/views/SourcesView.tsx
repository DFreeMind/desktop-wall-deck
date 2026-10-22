import { useEffect, useMemo, useRef, useState } from "react";
import { WALLPAPER_SOURCES, type WallpaperSource } from "../lib/wallpaperSources";
import {
  IconExternal,
  IconGlobe,
  IconRefresh,
  IconSearch,
} from "../components/icons";

interface Props {
  /**
   * 站点拒绝被嵌入时的兜底：在系统浏览器打开。
   *
   * 只有站点主动禁止内嵌（X-Frame-Options / CSP frame-ancestors）才会用到，
   * 常规浏览完全在应用内完成。
   */
  onOpenExternal: (url: string) => void;
}

/**
 * 壁纸来源页：应用内浏览。
 *
 * 布局是「左列表 + 右浏览区」：左边挑站点，右边直接加载页面，
 * 用户看完觉得合适就下载，然后把图拖回壁纸库——全程不离开应用。
 *
 * # 为什么用 iframe 而不是原生子 WebView
 *
 * 原生子 WebView（`add_child`）能绕过 X-Frame-Options，但需要开启 Tauri 的
 * `unstable` feature，并且要在窗口坐标系里手动跟随布局变化重排，
 * 与当前 React 布局耦合很重。绝大多数目标站点并未禁止内嵌，
 * iframe 已经够用；对少数禁止的站点，明确告知比强行破限更合适。
 *
 * # 内嵌的限制要说清楚
 *
 * 浏览器出于安全不允许父页面读取跨域 iframe 的 DOM，
 * 所以「加载失败」无法用代码判定——只能靠超时提示 + 手动回退。
 * 这比假装一切正常要诚实。
 */
export function SourcesView({ onOpenExternal }: Props) {
  const [activeId, setActiveId] = useState<string>(WALLPAPER_SOURCES[0].id);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [query, setQuery] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const active = WALLPAPER_SOURCES.find((s) => s.id === activeId) ?? WALLPAPER_SOURCES[0];

  /**
   * 加载态管理。
   *
   * 跨域 iframe 的 `onLoad` 并不可靠：站点被 X-Frame-Options 拒绝、
   * 或在重定向过程中被中断时，load 事件可能永远不触发。
   * 若只依赖它，遮罩会一直盖着，用户看不到「其实已经失败」。
   *
   * 因此再加一个兜底计时器：4 秒后无论如何撤掉遮罩。
   * 撤掉后用户看到的要么是页面，要么是浏览器自己的错误页——
   * 两者都比一块转圈的遮罩更接近真相。
   */
  useEffect(() => {
    setLoading(true);
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 6000);
    const giveUp = setTimeout(() => setLoading(false), 4500);
    return () => {
      clearTimeout(slowTimer);
      clearTimeout(giveUp);
    };
  }, [activeId, reloadKey]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return WALLPAPER_SOURCES;
    return WALLPAPER_SOURCES.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.blurb.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [query]);

  const pick = (s: WallpaperSource) => {
    setActiveId(s.id);
  };

  return (
    <div className="page page-flush sources-page">
      <header className="page-head">
        <div>
          <h1>壁纸来源</h1>
          <p className="page-sub">
            精选的免费壁纸站点，直接在应用内浏览。找到喜欢的图下载后，拖进壁纸库即可使用。
          </p>
        </div>
      </header>

      <div className="sources-body">
        {/* 左：站点列表 */}
        <aside className="sources-side">
          <label className="search search-block">
            <IconSearch size={13} />
            <input
              placeholder="筛选站点"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <ul className="source-list">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  className={`source-item${s.id === activeId ? " is-active" : ""}`}
                  onClick={() => pick(s)}
                >
                  <span className="source-item-icon">
                    <IconGlobe size={14} />
                  </span>
                  <span className="source-item-body">
                    <span className="source-item-name">
                      {s.name}
                      {!s.embeddable && <span className="source-item-flag">需外部打开</span>}
                    </span>
                    <span className="source-item-license">{s.license}</span>
                  </span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="source-list-empty">没有匹配的站点</li>}
          </ul>

          <p className="sources-note">
            授权说明仅供快速参考，实际使用前请以站点页面最新条款为准。
          </p>
        </aside>

        {/* 右：浏览区 */}
        <section className="sources-main">
          <div className="browser-bar">
            <div className="browser-bar-left">
              <button
                className="icon-plain"
                title="重新加载"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                <IconRefresh size={14} />
              </button>
              <span className="browser-url" title={active.url}>
                {stripScheme(active.url)}
              </span>
            </div>
            <div className="browser-bar-right">
              <span className="browser-license">{active.license}</span>
              <button
                className="ghost small"
                onClick={() => onOpenExternal(active.url)}
                title="在系统浏览器中打开"
              >
                <IconExternal size={12} />
                浏览器打开
              </button>
            </div>
          </div>

          <div className="browser-stage">
            {active.embeddable ? (
              <>
                <iframe
                  key={`${active.id}-${reloadKey}`}
                  ref={iframeRef}
                  className="browser-frame"
                  src={active.url}
                  title={active.name}
                  onLoad={() => setLoading(false)}
                  referrerPolicy="no-referrer-when-downgrade"
                />
                {loading && (
                  <div className="browser-overlay">
                    <span className="spinner" />
                    <span>正在加载 {active.name}…</span>
                    {slow && (
                      <p className="browser-overlay-hint">
                        加载较慢，可能是网络原因。可以重试，或在浏览器中打开。
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="browser-blocked">
                <span className="browser-blocked-icon">
                  <IconGlobe size={26} />
                </span>
                <h3>{active.name} 不允许被嵌入显示</h3>
                <p>
                  该站点设置了 <code>X-Frame-Options: SAMEORIGIN</code>，
                  禁止在自己的页面之外的框架中显示。这是站点的安全策略，应用无法绕过。
                </p>
                <p className="browser-blocked-hint">
                  想继续浏览这个站点，请用系统浏览器打开；在应用内可以先用左侧其他站点。
                </p>
                <button className="primary" onClick={() => onOpenExternal(active.url)}>
                  <IconExternal size={13} />
                  在浏览器中打开 {active.name}
                </button>
              </div>
            )}
          </div>

          <p className="sources-hint">
            {active.blurb}
            <span className="dot" />
            在站点下载图片后，回到「壁纸库」点「导入图片」，或直接把文件拖进窗口。
          </p>
        </section>
      </div>
    </div>
  );
}

/** 地址栏只显示主机与路径，去掉协议前缀，视觉上更像浏览器的地址栏。 */
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
