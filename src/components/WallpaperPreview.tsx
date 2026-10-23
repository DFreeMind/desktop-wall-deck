import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { Wallpaper } from "../lib/types";
import { api, assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { IconChevron, IconClose, IconExpand, IconMinus, IconMonitor, IconPlus } from "./icons";
import "../styles/immersivePreview.css";

interface Props {
  wallpaper: Wallpaper;
  items: Wallpaper[];
  onNavigate: (id: string) => void;
  onClose: () => void;
  onDetails: (wallpaper: Wallpaper) => void;
  controls?: ReactNode;
}

const focusableSelector = [
  "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)",
  "textarea:not(:disabled)", "a[href]", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 原图只在主动打开时按记录 ID 读取；切换与缩放都不会投放壁纸。 */
export function WallpaperPreview({ wallpaper, items, onNavigate, onClose, onDetails, controls }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const previousFilmId = useRef<string | null>(null);
  const applyTriggerRef = useRef<HTMLButtonElement>(null);
  const applyPanelRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [filmOpen, setFilmOpen] = useState(true);
  const [view, setView] = useState<{ id: string; zoom: number | null }>({ id: wallpaper.id, zoom: null });
  const zoom = view.id === wallpaper.id ? view.zoom : null;
  const index = items.findIndex((item) => item.id === wallpaper.id);
  const canPrevious = index > 0;
  const canNext = index >= 0 && index < items.length - 1;
  const reducedMotion = useReducedMotion();
  const revisions = useThumbnailRevision();
  const setZoom = (value: number | null) => setView({ id: wallpaper.id, zoom: value });

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const app = document.getElementById("root");
    const previousInert = app?.inert ?? false;
    if (app) app.inert = true;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (app) app.inert = previousInert;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const centerFilm = useCallback((behavior: ScrollBehavior) => {
    const film = filmRef.current;
    const item = film?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    if (!film || !item || !film.clientWidth) return;
    // 两端预留半个视口，第一张与最后一张也可以落在正中。
    film.style.setProperty("--film-side-space", `${Math.max(0, (film.clientWidth - item.offsetWidth) / 2)}px`);
    const trackBox = film.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    film.scrollTo({ left: film.scrollLeft + itemBox.left - trackBox.left + itemBox.width / 2 - film.clientWidth / 2, behavior });
  }, []);

  useLayoutEffect(() => {
    if (!filmOpen) return;
    centerFilm(reducedMotion || previousFilmId.current === null ? "instant" : "smooth");
    previousFilmId.current = wallpaper.id;
  }, [wallpaper.id, filmOpen, reducedMotion, centerFilm]);

  useEffect(() => {
    const film = filmRef.current;
    if (!film || !filmOpen) return;
    let width = film.clientWidth;
    const observer = new ResizeObserver(() => {
      if (film.clientWidth !== width) { width = film.clientWidth; centerFilm("instant"); }
    });
    observer.observe(film, { box: "border-box" });
    return () => observer.disconnect();
  }, [filmOpen, centerFilm]);

  useLayoutEffect(() => {
    if (!applyOpen) return;
    const canvas = canvasRef.current;
    const trigger = applyTriggerRef.current;
    const panel = applyPanelRef.current;
    if (!canvas || !trigger || !panel) return;
    const alignPanel = () => {
      const bounds = canvas.getBoundingClientRect();
      const anchor = trigger.getBoundingClientRect();
      // 右边缘对齐触发按钮，同时为窄窗口两侧保留安全间距。
      const right = Math.max(12, Math.min(bounds.right - anchor.right, bounds.width - panel.offsetWidth - 12));
      panel.style.right = `${right}px`;
    };
    alignPanel();
    const observer = new ResizeObserver(alignPanel);
    observer.observe(canvas);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [applyOpen]);

  useEffect(() => {
    if (!applyOpen) return;
    const frame = requestAnimationFrame(() => applyPanelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }));
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".wallpaper-apply-menu") || applyPanelRef.current?.contains(target) || applyTriggerRef.current?.contains(target)) return;
      setApplyOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", onPointerDown); };
  }, [applyOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogRef.current?.inert) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (applyOpen) { setApplyOpen(false); applyTriggerRef.current?.focus({ preventScroll: true }); }
        else onClose();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const arrowHandledByControl = Boolean(target?.isContentEditable || target?.closest("input, textarea, select, [contenteditable='true'], [role='menu']"));
      if (!arrowHandledByControl && event.key === "ArrowLeft" && canPrevious) { event.preventDefault(); onNavigate(items[index - 1].id); return; }
      if (!arrowHandledByControl && event.key === "ArrowRight" && canNext) { event.preventDefault(); onNavigate(items[index + 1].id); return; }
      if (event.key === "Tab") {
        const dialog = dialogRef.current;
        const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
          .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) { event.preventDefault(); dialog?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, items, index, canPrevious, canNext, applyOpen]);

  const navigate = (offset: number) => {
    const target = items[index + offset];
    if (target) onNavigate(target.id);
  };

  return createPortal(
    <m.div
      className="lightbox-backdrop immersive-preview-backdrop"
      initial={{ opacity: reducedMotion ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: reducedMotion ? 1 : 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <m.section
        className={`lightbox immersive-preview${filmOpen ? "" : " film-collapsed"}`}
        ref={dialogRef}
        role="dialog" aria-modal="true" aria-label="壁纸大图预览" tabIndex={-1}
        initial={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 8 }}
        animate={{ opacity: 1, y: 0 }} exit={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 6 }}
        transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
      >
        <header className="lightbox-head immersive-preview-head">
          <div className="lightbox-title immersive-preview-title"><strong title={wallpaper.name}>{wallpaper.name}</strong><span>{wallpaper.width} × {wallpaper.height} <span className="lightbox-dot">·</span> 原图预览</span></div>
          <span className="lightbox-counter immersive-preview-counter">{index + 1} / {items.length}</span>
          <div className="immersive-preview-tools" aria-label="图片缩放">
            <button className="immersive-fit-toggle" aria-label={zoom === null ? "查看原始尺寸" : "适应窗口显示"} title={zoom === null ? "当前适应窗口，点击查看原始尺寸" : "点击适应窗口"} onClick={() => setZoom(zoom === null ? 1 : null)}><IconExpand size={15} /><span>{zoom === null ? "适应" : `${Math.round(zoom * 100)}%`}</span></button>
            <button className="lightbox-icon immersive-icon" disabled={zoom !== null && zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, (zoom ?? 1) - 0.25))} aria-label="缩小图片"><IconMinus size={16} /></button>
            <button className="lightbox-icon immersive-icon" disabled={zoom !== null && zoom >= 4} onClick={() => setZoom(Math.min(4, (zoom ?? 1) + 0.25))} aria-label="放大图片"><IconPlus size={16} /></button>
          </div>
          <button className="immersive-header-action" onClick={() => onDetails(wallpaper)}>图片详情</button>
          <button className="immersive-header-action" aria-expanded={filmOpen} onClick={() => setFilmOpen((open) => !open)}>{filmOpen ? "收起胶片" : "显示胶片"}</button>
          {controls && <button ref={applyTriggerRef} className="immersive-apply-trigger" aria-expanded={applyOpen} aria-controls="gallery-apply-panel" onClick={() => setApplyOpen((open) => !open)}><IconMonitor size={15} />设置壁纸</button>}
          <button ref={closeRef} className="lightbox-icon immersive-icon" onClick={onClose} aria-label="关闭大图预览" title="关闭（Esc）"><IconClose size={19} /></button>
        </header>

        <div ref={canvasRef} className="immersive-preview-canvas">
          <button className="immersive-preview-arrow previous" disabled={!canPrevious} onClick={() => navigate(-1)} aria-label="上一张壁纸"><IconChevron size={20} className="rotate-180" /></button>
          <PreviewImage key={wallpaper.id} wallpaper={wallpaper} zoom={zoom} reducedMotion={Boolean(reducedMotion)} revisions={revisions} />
          <button className="immersive-preview-arrow next" disabled={!canNext} onClick={() => navigate(1)} aria-label="下一张壁纸"><IconChevron size={20} /></button>
          <AnimatePresence>
            {applyOpen && <m.section id="gallery-apply-panel" ref={applyPanelRef} className="immersive-apply-panel" aria-label="壁纸投放控制" initial={{ opacity: 0, y: reducedMotion ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }} transition={{ duration: reducedMotion ? 0 : .16 }}>
              <header><strong>将当前图片设为壁纸</strong><button onClick={() => { setApplyOpen(false); applyTriggerRef.current?.focus({ preventScroll: true }); }} aria-label="收起投放面板"><IconClose size={15} /></button></header>
              <p>选择屏幕，再点击应用。浏览图片不会改变桌面。</p>
              {controls}
            </m.section>}
          </AnimatePresence>
        </div>

        <footer className="immersive-preview-filmstrip">
          <div className="immersive-preview-film-heading">
            <strong>壁纸胶片</strong><span>← → 切换 · Esc 关闭</span>
          </div>
          <div ref={filmRef} className="immersive-preview-film" aria-label="壁纸列表">
            {items.map((item, itemIndex) => {
              const active = item.id === wallpaper.id;
              return <m.button
                key={item.id}
                className={`immersive-preview-film-item${active ? " is-current" : ""}`}
                onClick={() => onNavigate(item.id)}
                aria-label={`查看第 ${itemIndex + 1} 张：${item.name}`}
                aria-current={active ? "true" : undefined}
                animate={{ opacity: active ? 1 : 0.76 }}
                transition={{ duration: reducedMotion ? 0 : 0.16 }}
              >
                <img src={assetUrl(item.thumbPath, thumbnailVersion(revisions, item.id))} alt="" loading="lazy" draggable={false} />
                <span>{item.name}</span>
              </m.button>;
            })}
          </div>
        </footer>
      </m.section>
    </m.div>, document.body,
  );
}

function PreviewImage({ wallpaper, zoom, reducedMotion, revisions }: { wallpaper: Wallpaper; zoom: number | null; reducedMotion: boolean; revisions: ReturnType<typeof useThumbnailRevision> }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [natural, setNatural] = useState({ width: wallpaper.width, height: wallpaper.height });
  const stageRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setLoading(true); setFailed(false); setSrc(undefined);
    if (/^(data:|blob:|https?:)/i.test(wallpaper.filePath)) {
      setSrc(wallpaper.filePath);
    } else {
      void api.originalBytes(wallpaper.id).then((bytes) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)]));
        setSrc(objectUrl);
      }).catch(() => { if (!disposed) { setLoading(false); setFailed(true); } });
    }
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [wallpaper.id, wallpaper.filePath, attempt]);

  useEffect(() => { stageRef.current?.scrollTo(0, 0); }, [zoom]);

  return <div ref={stageRef} className={`lightbox-stage immersive-preview-stage${zoom === null ? " is-fit" : " is-zoomed"}`}>
    <div className="lightbox-image-frame immersive-preview-image-frame">
      {zoom === null && !failed && <img className="immersive-preview-placeholder" src={assetUrl(wallpaper.thumbPath, thumbnailVersion(revisions, wallpaper.id))} alt="" aria-hidden="true" draggable={false} />}
      {src && <m.img key={attempt} src={src} alt={wallpaper.name} draggable={false}
        className="lightbox-image immersive-preview-image"
        initial={{ opacity: 0 }}
        animate={{ opacity: loading || failed ? 0 : 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
        style={{ visibility: loading || failed ? "hidden" : "visible", ...(zoom === null ? {} : { width: natural.width * zoom, height: natural.height * zoom }) }}
        onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoading(false); setFailed(false); }}
        onError={() => { setLoading(false); setFailed(true); }}
      />}
    </div>
    {loading && <div className="lightbox-status immersive-preview-status" role="status"><span className="spinner" />正在加载原图…</div>}
    {failed && <div className="lightbox-status immersive-preview-status" role="alert"><strong>原图暂时无法显示</strong><span>文件可能已被移动或删除，请检查本地壁纸库。</span><button className="lightbox-text" onClick={() => { setLoading(true); setFailed(false); setAttempt((value) => value + 1); }}>重新加载原图</button></div>}
  </div>;
}
