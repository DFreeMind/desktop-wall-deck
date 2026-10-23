import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { Monitor } from "../lib/types";

export interface ExternalFileDropState {
  paths: string[];
  targetId: string | null;
  zone: "screen" | "library" | null;
  phase: "hover" | "working" | "success" | "error";
  message: string;
}

interface Options {
  enabled: boolean;
  busy: boolean;
  tile: boolean;
  monitors: Monitor[];
  onDrop: (paths: string[], targetId: string | null) => Promise<string>;
  onNotify: (message: string, kind: "success" | "warn" | "error") => void;
}

const imagePath = /\.(?:jpe?g|png|webp|bmp|gif|tiff?|avif)$/i;

/** 系统拖放是 WebView 原生事件，不能用 HTML File 对象推测本机绝对路径。 */
export function useExternalFileDrop(options: Options) {
  const config = useRef(options);
  config.current = options;
  const [state, setState] = useState<ExternalFileDropState | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let working = false;
    let cancelled = false;
    let paths: string[] = [];
    let unlisten: (() => void) | undefined;
    let frame = 0;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    let current: ExternalFileDropState | null = null;
    const publish = (value: ExternalFileDropState | null) => {
      current = value;
      if (alive) setState(value);
    };
    const locate = (physical: { x: number; y: number }) => {
      // Tauri 给出相对于 WebView 左上角的物理像素，DOM 命中需要 CSS 像素。
      const scale = window.devicePixelRatio || 1;
      const element = document.elementFromPoint(physical.x / scale, physical.y / scale);
      const id = element?.closest<HTMLElement>("[data-wallpaper-drop-target]")?.dataset.wallpaperDropTarget;
      const target = config.current.monitors.find((monitor) => monitor.identity === id);
      if (target) return { targetId: target.identity, zone: "screen" as const, name: target.name };
      return { targetId: null, zone: element?.closest(".library") ? "library" as const : null, name: null };
    };
    const describe = (position: { x: number; y: number }): ExternalFileDropState => {
      const { enabled, busy, tile } = config.current;
      const hit = locate(position);
      const problem = !enabled ? "请在壁纸库或显示器页面拖入图片"
        : busy ? "正在处理图片，请稍候"
          : !paths.length || paths.some((path) => !imagePath.test(path)) ? "仅支持图片文件，请勿拖入文件夹或其他文件"
            : hit.zone === "screen" && paths.length !== 1 ? "设置屏幕时请一次拖入一张图片"
              : hit.zone === "screen" && tile ? "平铺不支持单屏拖放，请先切换为填充或适应"
                : null;
      return { paths, targetId: problem ? null : hit.targetId, zone: problem ? null : hit.zone, phase: "hover",
        message: problem ?? (hit.zone === "screen" ? `松开，索引并设置到${hit.name}`
          : hit.zone === "library" ? `松开，将 ${paths.length} 张图片加入壁纸库 · 不修改桌面`
            : "拖到屏幕设置壁纸，或拖到图库仅添加索引") };
    };
    const onEvent = (event: DragDropEvent) => {
      if (!alive || working) return;
      if (event.type === "leave") { paths = []; cancelled = false; publish(null); return; }
      if (event.type === "enter") {
        clearTimeout(resetTimer);
        cancelled = false;
        paths = [...new Set(event.paths)];
      }
      if (cancelled) return;
      if (event.type === "drop") paths = [...new Set(event.paths)];
      if (!paths.length) return;
      const next = describe(event.position);
      if (event.type !== "drop") {
        // 只在目标或提示改变时重绘；首次进入后的下一帧重测新出现的浮动投放栏。
        if (current?.message !== next.message || current.targetId !== next.targetId || current.phase !== "hover") publish(next);
        if (event.type === "enter") {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => { if (alive && !working && !cancelled && paths.length) publish(describe(event.position)); });
        }
        return;
      }
      cancelAnimationFrame(frame);
      if (!next.zone) {
        paths = [];
        publish(null);
        config.current.onNotify(next.message, "warn");
        return;
      }
      // 原生 drop 可能紧跟重复回调，先锁住，再启动异步索引和投放。
      working = true;
      publish({ ...next, phase: "working", message: next.targetId ? "正在建立索引并设置壁纸…" : "正在索引本机图片…" });
      void config.current.onDrop(next.paths, next.targetId).then((message) => {
        if (!alive) return;
        publish({ ...next, phase: "success", message });
        config.current.onNotify(message, "success");
      }).catch((error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        publish({ ...next, phase: "error", message });
        config.current.onNotify(message, "error");
      }).finally(() => {
        working = false;
        paths = [];
        if (alive) resetTimer = setTimeout(() => publish(null), current?.phase === "error" ? 1800 : 900);
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working && current?.phase === "hover") {
        cancelled = true; paths = []; cancelAnimationFrame(frame); publish(null);
      }
    };
    window.addEventListener("keydown", onKey);
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      if (!alive) return () => {};
      return getCurrentWebview().onDragDropEvent(({ payload }) => onEvent(payload));
    })().then((off) => {
      if (alive) unlisten = off; else off();
    }).catch((error: unknown) => {
      if (alive) config.current.onNotify(`系统文件拖放监听失败：${String(error)}`, "error");
    });
    return () => { alive = false; cancelAnimationFrame(frame); clearTimeout(resetTimer); unlisten?.(); window.removeEventListener("keydown", onKey); };
  }, []);

  return state;
}
