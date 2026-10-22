import { useEffect, useMemo, useRef, useState } from "react";
import { api, assetUrl } from "../lib/api";
import type { Monitor, ScreenWallpaper, Wallpaper } from "../lib/types";

/**
 * 计算每块屏当前实际展示的壁纸。
 *
 * # 为什么不能只按库内路径匹配
 *
 * 系统当前壁纸的来源很杂：
 *
 * - 本应用设置的 → 路径就是库内副本，能直接按路径命中
 * - 用户用系统「个性化」设的 → `Themes\TranscendedWallpaper` 之类，不在库内
 * - Windows 聚焦壁纸 → `Themes\CachedFiles\*.jpg`，也不在库内
 *
 * 后两种路径都不在 asset 协议白名单里，直接拼地址会静默失败（图片空白，
 * 控制台无任何报错）。所以：
 *
 * 1. 先按库内 filePath 精确匹配（最准，且能拿到名字、尺寸等元数据）
 * 2. 没命中时把路径交给后端解码成 data URL，至少把「长什么样」显示出来
 *
 * 外部图的解码结果按路径缓存，拓扑刷新时不会重复解码同一张图。
 */
export function useScreenWallpapers(
  monitors: Monitor[],
  wallpapers: Wallpaper[],
): Map<string, ScreenWallpaper> {
  /** path → dataURL；用 ref 存缓存，避免每次渲染重建对象 */
  const cacheRef = useRef(new Map<string, string | null>());
  /** 记录发起中的请求，防止同一条路径被并发解码多次 */
  const inflightRef = useRef(new Set<string>());
  const [, forceRender] = useState(0);

  const byPath = useMemo(() => {
    const m = new Map<string, Wallpaper>();
    for (const w of wallpapers) m.set(normalize(w.filePath), w);
    return m;
  }, [wallpapers]);

  const map = useMemo(() => {
    const out = new Map<string, ScreenWallpaper>();
    for (const mon of monitors) {
      const path = mon.currentWallpaper;
      if (!path) continue;

      const hit = byPath.get(normalize(path));
      if (hit) {
        out.set(mon.identity, {
          kind: "library",
          wallpaper: hit,
          // 用缩略图而不是原图：画布上的屏只有一两百像素，
          // 原图可能几 MB，逐屏加载会让画布闪烁且拖慢首屏。
          preview: assetUrl(hit.thumbPath),
        });
        continue;
      }

      const cached = cacheRef.current.get(path);
      out.set(mon.identity, {
        kind: "external",
        // undefined 表示还没解码完，null 表示解码失败
        preview: cached === undefined ? null : cached,
      });
    }
    return out;
  }, [monitors, byPath]);

  // 为所有未命中库的外部壁纸补齐预览
  useEffect(() => {
    let cancelled = false;

    for (const mon of monitors) {
      const path = mon.currentWallpaper;
      if (!path) continue;
      if (byPath.has(normalize(path))) continue;
      if (cacheRef.current.has(path) || inflightRef.current.has(path)) continue;

      inflightRef.current.add(path);
      void api
        .currentWallpaperPreview(path)
        .then((dataUrl) => {
          cacheRef.current.set(path, dataUrl);
        })
        .catch(() => {
          // 文件已不存在或格式不支持：记 null，不要反复重试
          cacheRef.current.set(path, null);
        })
        .finally(() => {
          inflightRef.current.delete(path);
          if (!cancelled) forceRender((n) => n + 1);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [monitors, byPath]);

  return map;
}

/** 路径规范化：Windows 路径大小写不敏感，分隔符也可能混用。 */
function normalize(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}
