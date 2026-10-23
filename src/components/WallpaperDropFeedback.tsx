import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import type { WallpaperDragState } from "../hooks/useWallpaperDrag";
import { IconClose, IconMonitor } from "./icons";

export function WallpaperDropFeedback({ drag, identity, small }: { drag: WallpaperDragState | null; identity: string; small: boolean }) {
  const revision = useThumbnailRevision();
  const reduced = useReducedMotion();
  const target = drag?.targetIds.includes(identity) ? drag : null;
  const text = target?.phase === "applying" ? "正在设置…" : target?.phase === "success" ? "已设置"
    : target?.phase === "error" ? "未能设置" : target?.previewOnly ? "松开预览，尚未应用" : target && target.targetIds.length > 1 ? `松开，设置 ${target.targetIds.length} 块屏` : "松开，设置到此屏";
  return <AnimatePresence>
    {target && <m.img key={`preview-${target.wallpaper.id}`} className="screen-drop-preview" alt="待投放壁纸预览"
      src={assetUrl(target.wallpaper.thumbPath, thumbnailVersion(revision, target.wallpaper.id))}
      initial={{ opacity: 0 }} animate={{ opacity: target.phase === "success" || target.phase === "error" ? 0 : .88 }}
      exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .18 }} draggable={false} />}
    {target && <m.div key="drop-feedback" className={`screen-drop-feedback${small ? " is-compact" : ""}`}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .14 }}>
      <span className={target.phase === "applying" ? "spinner" : target.phase === "success" ? "check" : ""}>
        {target.phase === "success" ? <m.svg key="success-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <m.path d="m5 12 4 4L19 6" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduced ? 0 : .24, ease: "easeOut" }} />
        </m.svg> : target.phase === "error" ? <IconClose size={15} /> : target.phase !== "applying" ? <IconMonitor size={15} /> : null}
      </span>
      <small>{text}</small>
    </m.div>}
  </AnimatePresence>;
}
