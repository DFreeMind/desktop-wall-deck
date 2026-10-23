import { FitAdviceHint } from "./FitAdviceHint";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { createPortal } from "react-dom";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Monitor, Position, ScreenWallpaper, Wallpaper } from "../lib/types";
import { POSITION_LABELS, monitorSize } from "../lib/types";
import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { IconCheck, IconExpand, IconLayers, IconMonitor, IconMore } from "./icons";
import "../styles/wallpaperApplyBar.css";

export interface WallpaperApplyBarProps {
  monitors: Monitor[];
  selected: Set<string>;
  wallpaperMap: Map<string, ScreenWallpaper>;
  pendingWallpaper: Wallpaper | null;
  onPreview: (wallpaper: Wallpaper) => void;
  onRelink: (wallpaper: Wallpaper) => void;
  position: Position;
  onPositionChange: (p: Position) => void;
  fitMessage: string | null;
  onApplyAll: () => void;
  onApplySelected: () => void;
  onApplySpan: () => void;
  busy: boolean;
  onClearSelection: () => void;
  onToggleSelect: (identity: string, additive: boolean) => void;
  onRefresh: () => void;
  compact?: boolean;
  inlineNote?: boolean;
}

const POSITIONS: Position[] = ["fill", "fit", "stretch", "center", "tile"];

export function WallpaperApplyBar({
  monitors, selected, wallpaperMap, pendingWallpaper, onPreview, onRelink,
  position, onPositionChange, fitMessage, onApplyAll, onApplySelected, onApplySpan,
  busy, onClearSelection, onToggleSelect, compact = false, inlineNote = false,
}: WallpaperApplyBarProps) {
  const reduced = useReducedMotion();
  const revision = useThumbnailRevision();
  const selectedMonitors = monitors.filter((monitor) => selected.has(monitor.identity));
  const appliedToSelection = !!pendingWallpaper && selectedMonitors.length > 0 && selectedMonitors.every((monitor) => {
    const current = wallpaperMap.get(monitor.identity);
    return current?.kind === "library" && current.wallpaper.id === pendingWallpaper.id;
  });
  const physicalMonitors = monitors.filter((monitor) => monitor.kind !== "virtual");
  const canApply = !!pendingWallpaper && !pendingWallpaper.missing && !busy;
  const canApplySelected = canApply && selectedMonitors.length > 0 && position !== "tile";
  const canApplyAll = canApply && monitors.length > 0;
  const canApplySpan = canApply && physicalMonitors.length >= 2;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; maxHeight: number }>({ left: 0, top: 0, maxHeight: 300 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const thumbnail = pendingWallpaper && !compact
    ? assetUrl(pendingWallpaper.thumbPath, thumbnailVersion(revision, pendingWallpaper.id))
    : undefined;
  const primaryMonitor = monitors.find((monitor) => monitor.primary);

  const getMonitorLabel = (monitor: Monitor) => {
    if (monitor.primary) return "主屏";
    if (!primaryMonitor) return monitor.name;
    if (monitor.rect.left < primaryMonitor.rect.left) return "左屏";
    if (monitor.rect.left > primaryMonitor.rect.left) return "右屏";
    return monitor.name;
  };

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(Math.max(menuRect.width, 220), window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    const roomBelow = window.innerHeight - rect.bottom - margin;
    const roomAbove = rect.top - margin;
    const maxHeight = Math.max(120, Math.min(360, Math.max(roomBelow, roomAbove)));
    const top = roomBelow >= Math.min(menuRect.height, maxHeight) || roomBelow >= roomAbove
      ? Math.min(rect.bottom + 8, window.innerHeight - margin - Math.min(menuRect.height, maxHeight))
      : Math.max(margin, rect.top - 8 - Math.min(menuRect.height, maxHeight));
    setMenuStyle({ left, top, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    positionMenu();
    const frame = requestAnimationFrame(() => {
      (menuRef.current?.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      if (!menuRef.current?.contains(document.activeElement)) return;
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!items?.length) return;
      const current = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(current + delta + items.length) % items.length].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1].focus();
      }
    };
    const onViewportChange = () => positionMenu();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [menuOpen, positionMenu, closeMenu]);

  const handleMenuAction = (action: () => void) => {
    closeMenu(true);
    action();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!items?.length) return;
      event.preventDefault();
      const current = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
      items[(current + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  };

  // 动画弹层的 transform 会改变 fixed 定位参照；菜单始终脱离裁切祖先。
  const menuHost = document.body;

  return (
    <m.section
      className={`wallpaper-apply-bar${compact ? " is-compact" : ""}`}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.18, ease: "easeOut" }}
      aria-label="壁纸投放操作"
    >
      {!compact && <div className="wallpaper-apply-selection">
        <div className="wallpaper-apply-thumb-wrap">
          <AnimatePresence mode="wait" initial={false}>
            {thumbnail ? (
              <m.img
                key={pendingWallpaper?.id}
                className="wallpaper-apply-thumb"
                src={thumbnail}
                alt=""
                decoding="async"
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduced ? undefined : { opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.14 }}
              />
            ) : (
              <m.span key="empty" className="wallpaper-apply-thumb wallpaper-apply-thumb-empty" aria-hidden="true">
                <IconMonitor size={18} />
              </m.span>
            )}
          </AnimatePresence>
        </div>
        <div className="wallpaper-apply-wallpaper-meta">
          {pendingWallpaper ? (
            <>
              <strong className="wallpaper-apply-name" title={pendingWallpaper.name}>{pendingWallpaper.name}</strong>
              <span className="wallpaper-apply-dimensions">
                {pendingWallpaper.width} × {pendingWallpaper.height} · {appliedToSelection ? "已用于选中屏幕" : "仅预览，应用后生效"}
              </span>
            </>
          ) : (
            <span className="wallpaper-apply-empty-label">尚未选择壁纸</span>
          )}
        </div>
        {pendingWallpaper && !compact && (
          <button className="wallpaper-apply-preview" type="button" aria-label="查看大图" title="查看大图" onClick={() => onPreview(pendingWallpaper)}>
            <IconExpand size={15} />
          </button>
        )}
        {pendingWallpaper?.missing && (
          <div className="wallpaper-apply-missing" role="status">
            <span>原文件不可用</span>
            {pendingWallpaper.storageKind === "indexed" && (
              <button type="button" onClick={() => onRelink(pendingWallpaper)}>重新定位</button>
            )}
          </div>
        )}
      </div>}

      <div className="wallpaper-apply-targets">
        <div className="wallpaper-apply-target-heading">
          <span className="wallpaper-apply-target-prompt">选择投放屏幕</span>
          {selectedMonitors.length > 0 && <button type="button" onClick={onClearSelection}>清除选择</button>}
        </div>
        <div className="wallpaper-apply-chips" aria-label="选择目标屏幕">
          {monitors.length === 0 ? <span className="wallpaper-apply-no-monitors">未检测到显示器</span> : monitors.map((monitor) => {
            const isSelected = selected.has(monitor.identity);
            const { w, h } = monitorSize(monitor);
            const current = wallpaperMap.get(monitor.identity);
            const currentLabel = current?.kind === "library" ? current.wallpaper.name : current ? "系统壁纸" : "未设置";
            return (
              <button
                key={monitor.identity}
                type="button"
                className={`wallpaper-apply-chip${isSelected ? " is-selected" : ""}`}
                onClick={() => onToggleSelect(monitor.identity, true)}
                aria-pressed={isSelected}
                data-wallpaper-drop-target={monitor.identity}
                title={`${monitor.name} · ${w}×${h} · 当前：${currentLabel}${monitor.primary ? " · 主屏" : ""}`}
              >
                <span className="wallpaper-apply-chip-check" aria-hidden="true">{isSelected ? <IconCheck size={12} /> : <IconMonitor size={17} />}</span>
                <span className="wallpaper-apply-chip-copy"><strong>{getMonitorLabel(monitor)}</strong><small>{w}×{h}</small></span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="wallpaper-apply-controls">
        {compact && pendingWallpaper?.missing && (
          <div className="wallpaper-apply-missing" role="status">
            <span>原文件不可用</span>
            {pendingWallpaper.storageKind === "indexed" && (
              <button type="button" onClick={() => onRelink(pendingWallpaper)}>重新定位</button>
            )}
          </div>
        )}
        <div className="wallpaper-apply-position">
          <span className="wallpaper-apply-position-label">填充方式{inlineNote && (fitMessage || position === "tile") && <FitAdviceHint message={fitMessage ?? "平铺是系统全屏模式；单独选屏不可用。"} />}</span>
          <select value={position} onChange={(event) => onPositionChange(event.target.value as Position)} aria-label="填充方式">
            {POSITIONS.map((item) => <option key={item} value={item}>{POSITION_LABELS[item]}</option>)}
          </select>
        </div>
        <div className="wallpaper-apply-actions">
          <button
            type="button"
            className="wallpaper-apply-primary"
            onClick={onApplySelected}
            disabled={!canApplySelected}
            title={position === "tile" ? "平铺会应用到全部屏幕，请使用更多投放操作" : !selectedMonitors.length ? "请先选择目标屏幕" : `应用到选中的 ${selectedMonitors.length} 块屏幕`}
          >
            {busy ? <><span className="spinner" aria-hidden="true" />正在处理…</> : pendingWallpaper?.missing ? "原文件不可用"
              : !pendingWallpaper ? "先选一张壁纸"
                : position === "tile" ? "平铺仅支持应用到全部"
                  : selectedMonitors.length ? "应用壁纸"
                    : "先选择目标屏幕"}
          </button>
          <button
            ref={triggerRef}
            type="button"
            className="wallpaper-apply-more"
            aria-label="更多投放操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "wallpaper-apply-menu" : undefined}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconMore size={18} />
          </button>
        </div>
      </div>
      {!inlineNote && (fitMessage || position === "tile") && (
        <div className="wallpaper-apply-note" role="status">
          {fitMessage ?? "平铺是系统全屏模式；单独选屏不可用。"}
        </div>
      )}

      {createPortal(
        <AnimatePresence>
          {menuOpen && <m.div
            id="wallpaper-apply-menu"
            ref={menuRef}
            className="wallpaper-apply-menu"
            role="menu"
            aria-label="更多投放操作"
            onKeyDown={onMenuKeyDown}
            style={{ left: menuStyle.left, top: menuStyle.top, maxHeight: menuStyle.maxHeight }}
            initial={reduced ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 5 }}
            transition={{ duration: reduced ? 0 : 0.13 }}
          >
            <button type="button" role="menuitem" disabled={!canApplyAll} onClick={() => handleMenuAction(onApplyAll)}>
              <IconMonitor size={15} />
              <span><strong>应用到全部 {monitors.length} 块屏幕</strong><small>所有屏幕使用同一张壁纸</small></span>
            </button>
            <button type="button" role="menuitem" disabled={!canApplySpan || position === "tile"} onClick={() => handleMenuAction(onApplySpan)}>
              <IconLayers size={15} />
              <span><strong>跨屏拼接铺满 {physicalMonitors.length} 块屏</strong><small>{position === "tile" ? "平铺模式下不可用" : "按显示器位置裁切并分别投放"}</small></span>
            </button>
          </m.div>}
        </AnimatePresence>,
        menuHost,
      )}
    </m.section>
  );
}
