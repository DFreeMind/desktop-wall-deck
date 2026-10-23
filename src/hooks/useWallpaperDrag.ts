import { useEffect, useRef, useState } from "react";
import { useMotionValue } from "motion/react";
import type { Monitor, Wallpaper } from "../lib/types";

export interface WallpaperDragState {
  wallpaper: Wallpaper;
  phase: "dragging" | "applying" | "success" | "error";
  targetIds: string[];
  previewOnly?: boolean;
  message: string;
}

interface Options {
  previewOnly?: boolean;
  monitors: Monitor[];
  selected: Set<string>;
  busy: boolean;
  disabledReason: string | null;
  onApply: (wallpaper: Wallpaper, identities: string[]) => Promise<string>;
  onNotify: (message: string, kind: "success" | "warn" | "error") => void;
}

interface PointerSession {
  wallpaper: Wallpaper;
  pointerId: number;
  origin: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
}

/** 应用内拖放使用 Pointer Events，不经过 Windows WebView 的原生文件拖放通道。 */
export function useWallpaperDrag(options: Options) {
  const config = useRef(options);
  config.current = options;
  const [state, setState] = useState<WallpaperDragState | null>(null);
  const current = useRef<WallpaperDragState | null>(null);
  const session = useRef<PointerSession | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  useEffect(() => {
    let alive = true;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressClick = false;
    let cancelledPointer: number | null = null;
    const publish = (value: WallpaperDragState | null) => { current.current = value; if (alive) setState(value); };
    const positionGhost = (clientX: number, clientY: number) => {
      // MotionValue 直接更新合成层，不随每个 pointermove 重绘整个图片网格。
      x.set(Math.max(8, Math.min(innerWidth - 190, clientX + 18)));
      y.set(Math.max(8, Math.min(innerHeight - 170, clientY + 18)));
    };
    const captureClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault(); event.stopImmediatePropagation();
      suppressClick = false;
    };
    const release = () => {
      const pending = session.current;
      session.current = null;
      document.body.classList.remove("wallpaper-dragging");
      if (pending?.origin.hasPointerCapture(pending.pointerId)) pending.origin.releasePointerCapture(pending.pointerId);
      if (pending?.started) {
        suppressClick = true;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { suppressClick = false; }, 60);
      }
    };
    const targetsAt = (clientX: number, clientY: number, shift: boolean) => {
      const id = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-wallpaper-drop-target]")?.dataset.wallpaperDropTarget;
      const { monitors, selected } = config.current;
      if (!id || !monitors.some((monitor) => monitor.identity === id)) return [];
      // 默认只投放到落点。多屏必须显式按 Shift，且落点必须在选中集合中。
      return shift && selected.has(id) && selected.size > 1
        ? monitors.filter((monitor) => selected.has(monitor.identity)).map((monitor) => monitor.identity)
        : [id];
    };
    const updateTarget = (clientX: number, clientY: number, shift: boolean) => {
      const drag = current.current;
      if (!drag || drag.phase !== "dragging") return;
      const ids = targetsAt(clientX, clientY, shift);
      if (ids.join("|") === drag.targetIds.join("|")) return;
      const name = config.current.monitors.find((monitor) => monitor.identity === ids[0])?.name;
      publish({ ...drag, targetIds: ids, message: config.current.previewOnly && ids.length ? "松开预览，点击应用后生效" : ids.length > 1 ? `松开，应用到已选 ${ids.length} 块屏幕`
        : name ? `松开，仅应用到${name}` : "拖到显示器上，松开即设置 · Esc 取消" });
    };
    const onMove = (event: PointerEvent) => {
      const pending = session.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      pending.x = event.clientX; pending.y = event.clientY;
      if (!pending.started) {
        if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 7) return;
        const { busy, disabledReason } = config.current;
        if (busy || disabledReason || pending.wallpaper.missing) {
          release();
          config.current.onNotify(busy ? "正在应用壁纸，请稍候" : disabledReason ?? "原文件不可用，请先重新定位", "warn");
          return;
        }
        pending.started = true;
        pending.origin.setPointerCapture(pending.pointerId);
        document.body.classList.add("wallpaper-dragging");
        publish({ wallpaper: pending.wallpaper, phase: "dragging", targetIds: [], previewOnly: config.current.previewOnly, message: config.current.previewOnly ? "拖到显示器上预览 · 点击应用后生效" : "拖到显示器上，松开即设置 · Esc 取消" });
      }
      event.preventDefault();
      positionGhost(event.clientX, event.clientY);
      updateTarget(event.clientX, event.clientY, event.shiftKey);
    };
    const cancel = (waitForUp = false) => {
      if (!session.current) return;
      const pending = session.current;
      release(); publish(null);
      if (waitForUp && pending.started) {
        cancelledPointer = pending.pointerId;
        clearTimeout(clickTimer);
        suppressClick = true;
      }
    };
    const onUp = (event: PointerEvent) => {
      const pending = session.current;
      if (!pending) {
        if (cancelledPointer === event.pointerId) {
          cancelledPointer = null;
          clickTimer = setTimeout(() => { suppressClick = false; }, 60);
        }
        return;
      }
      if (event.pointerId !== pending.pointerId) return;
      if (!pending.started) { release(); return; }
      event.preventDefault();
      const ids = targetsAt(event.clientX, event.clientY, event.shiftKey);
      release();
      if (!ids.length) { publish(null); return; }
      if (config.current.previewOnly) {
        publish(null);
        void config.current.onApply(pending.wallpaper, ids).then(message => config.current.onNotify(message, "success")).catch((error: unknown) => config.current.onNotify(error instanceof Error ? error.message : String(error), "error"));
        return;
      }
      const applying: WallpaperDragState = { wallpaper: pending.wallpaper, targetIds: ids, phase: "applying", message: `正在应用到 ${ids.length} 块屏幕…` };
      publish(applying);
      void config.current.onApply(pending.wallpaper, ids).then((message) => {
        if (!alive) return;
        publish({ ...applying, phase: "success", message });
        config.current.onNotify(message, "success");
      }).catch((error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        publish({ ...applying, phase: "error", message });
        config.current.onNotify(message, "error");
      }).finally(() => {
        if (alive) resetTimer = setTimeout(() => publish(null), current.current?.phase === "error" ? 1600 : 800);
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current?.started) { event.preventDefault(); cancel(true); }
      else if (event.key === "Shift" && session.current?.started) {
        const pointer = session.current;
        updateTarget(pointer.x, pointer.y, event.type === "keydown");
      }
    };
    const pointerCancelled = (event: PointerEvent) => { if (event.pointerId === session.current?.pointerId) cancel(); };
    const onBlur = () => cancel();
    const onDown = () => { if (cancelledPointer !== null) { cancelledPointer = null; suppressClick = false; } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", pointerCancelled, true);
    window.addEventListener("lostpointercapture", pointerCancelled, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("click", captureClick, true);
    return () => {
      alive = false; release(); current.current = null;
      clearTimeout(resetTimer); clearTimeout(clickTimer);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", pointerCancelled, true);
      window.removeEventListener("lostpointercapture", pointerCancelled, true);
      window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur); window.removeEventListener("click", captureClick, true);
    };
  }, [x, y]);

  const start = (wallpaper: Wallpaper, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch" || current.current || session.current
      || (event.target as HTMLElement).closest("button,a,input,select,textarea")) return;
    session.current = { wallpaper, pointerId: event.pointerId, origin: event.currentTarget, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, started: false };
  };
  return { state, start, x, y };
}
