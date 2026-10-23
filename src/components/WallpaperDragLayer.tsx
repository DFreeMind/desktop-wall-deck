import { createPortal } from "react-dom";
import { AnimatePresence, type MotionValue, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type { Monitor, ScreenWallpaper } from "../lib/types";
import type { WallpaperDragState } from "../hooks/useWallpaperDrag";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { assetUrl } from "../lib/api";
import { IconMonitor } from "./icons";

interface Props {
  drag: WallpaperDragState | null;
  x: MotionValue<number>;
  y: MotionValue<number>;
  monitors: Monitor[];
  wallpaperMap: Map<string, ScreenWallpaper>;
  showShelf: boolean;
  selectedCount: number;
}

export function WallpaperDragLayer({ drag, x, y, monitors, wallpaperMap, showShelf, selectedCount }: Props) {
  const reduced = useReducedMotion();
  const revision = useThumbnailRevision();
  return createPortal(<div className="wallpaper-drag-layer">
    <AnimatePresence>
      {drag && showShelf && <m.div className="wallpaper-drop-shelf" key="drop-shelf"
        initial={{ opacity: 0, y: reduced ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4 }}
        transition={{ duration: reduced ? 0 : .18 }}>
        <div className="drop-shelf-head"><strong>{drag.previewOnly ? "拖到屏幕，松开预览" : "拖到屏幕，松开设置"}</strong><span>{selectedCount > 1 ? "按住 Shift，可投放到已选屏幕" : "Esc 取消 · 不影响其他屏幕"}</span></div>
        <div className="drop-shelf-targets">
          {monitors.map((monitor) => {
            const targeted = drag.targetIds.includes(monitor.identity);
            const preview = wallpaperMap.get(monitor.identity)?.preview;
            return <div key={monitor.identity} className={`drop-shelf-target${targeted ? ` is-drop-target is-drop-${drag.phase}` : ""}`}
              data-wallpaper-drop-target={monitor.identity} aria-label={`投放到${monitor.name}`}>
              {preview ? <img src={preview} alt="" draggable={false} /> : <IconMonitor size={25} />}
              <strong>{monitor.name}<small>{targeted && drag.phase === "applying" ? "正在设置…" : targeted && drag.phase === "success" ? "已设置" : targeted ? drag.previewOnly ? "松开预览" : "松开应用" : monitor.primary ? "主屏" : `${monitor.rect.right - monitor.rect.left} × ${monitor.rect.bottom - monitor.rect.top}`}</small></strong>
            </div>;
          })}
        </div>
      </m.div>}
      {drag && <m.div key="wallpaper-ghost" className={`wallpaper-drag-ghost is-${drag.phase}`} style={{ x, y }}
        initial={{ opacity: 0, scale: reduced ? 1 : .94 }}
        animate={{ opacity: drag.phase === "success" ? 0 : 1, scale: reduced ? 1 : drag.phase === "applying" ? .96 : drag.phase === "success" ? .9 : 1 }}
        exit={{ opacity: 0, scale: reduced ? 1 : .94 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32 }}>
        <img src={assetUrl(drag.wallpaper.thumbPath, thumbnailVersion(revision, drag.wallpaper.id))} alt="" draggable={false} />
        <div className="drag-ghost-caption"><strong>{drag.wallpaper.name}</strong><span>{drag.message}</span></div>
      </m.div>}
    </AnimatePresence>
    <div className="drag-live-status" role="status" aria-live="polite">{drag?.message ?? ""}</div>
  </div>, document.body);
}
