import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WALLPAPER_SOURCES } from "../lib/wallpaperSources";
import { IconExternal, IconGlobe } from "../components/icons";

/**
 * 壁纸来源页。
 *
 * 只做「入口」，不做抓取与内置浏览器：
 * 这些站点的授权条款各不相同，用户需要自己看到原始页面的说明。
 * 应用内的职责是把值得去的站点挑出来、讲清楚各自特点，然后交还控制权。
 */
export function SourcesView({ onError }: { onError: (msg: string) => void }) {
  const [pending, setPending] = useState<string | null>(null);

  const openSite = async (id: string, url: string) => {
    setPending(id);
    try {
      await openUrl(url);
    } catch (e) {
      onError(`无法打开链接：${(e as Error).message ?? e}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>壁纸来源</h1>
          <p className="page-sub">
            精选的免费壁纸站点。点击后在系统浏览器中打开，下载完成的图片可以直接拖进本应用。
          </p>
        </div>
      </header>

      <div className="source-grid">
        {WALLPAPER_SOURCES.map((s) => (
          <article key={s.id} className="source-card">
            <div className="source-head">
              <span className="source-favicon">
                <IconGlobe size={16} />
              </span>
              <div className="source-title-wrap">
                <h2>{s.name}</h2>
                <span className="source-license">{s.license}</span>
              </div>
            </div>
            <p className="source-blurb">{s.blurb}</p>
            <div className="source-foot">
              <div className="source-tags">
                {s.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
              <button
                className="source-open"
                onClick={() => void openSite(s.id, s.url)}
                disabled={pending === s.id}
              >
                {pending === s.id ? "打开中…" : "访问"}
                <IconExternal size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>

      <p className="page-note">
        授权说明仅供快速参考，实际使用前请以站点页面的最新条款为准。
        商用场景务必逐张确认，部分站点对「转载来的图片」并不持有再授权权利。
      </p>
    </div>
  );
}
