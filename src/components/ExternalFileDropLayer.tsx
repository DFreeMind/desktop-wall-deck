import { createPortal } from "react-dom";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type { ExternalFileDropState } from "../hooks/useExternalFileDrop";
import type { Monitor, ScreenWallpaper } from "../lib/types";
import { IconCheck, IconImage, IconMonitor } from "./icons";
import "../styles/externalFileDrop.css";

interface Props {
  state: ExternalFileDropState | null;
  monitors: Monitor[];
  wallpaperMap: Map<string, ScreenWallpaper>;
  showShelf: boolean;
}

export function ExternalFileDropLayer({ state, monitors, wallpaperMap, showShelf }: Props) {
  const reduced = useReducedMotion();
  return createPortal(<div className="external-file-drop-layer">
    <AnimatePresence>
      {state && <m.div key="native-drop" className={`external-file-drop is-${state.phase}`}
        initial={{ opacity: 0, y: reduced ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4 }}
        transition={{ duration: reduced ? 0 : .16 }}>
        <div className="external-file-drop-heading">
          <span className="external-file-drop-icon">{state.phase === "working" ? <span className="spinner" /> : state.phase === "success" ? <IconCheck size={19} /> : <IconImage size={19} />}</span>
          <div><strong>{state.paths.length === 1 ? state.paths[0].split(/[\\/]/).pop() : `${state.paths.length} 张本机图片`}</strong><span role="status">{state.message}</span></div>
        </div>
        {showShelf && state.phase === "hover" && <div className="drop-shelf-targets">
          {monitors.map((monitor) => <div key={monitor.identity}
            className={`drop-shelf-target${state.targetId === monitor.identity ? " is-drop-target" : ""}`}
            data-wallpaper-drop-target={monitor.identity} aria-label={`投放到${monitor.name}`}>
            {wallpaperMap.get(monitor.identity)?.preview ? <img src={wallpaperMap.get(monitor.identity)!.preview!} alt="" draggable={false} /> : <IconMonitor size={25} />}
            <strong>{monitor.name}<small>{state.targetId === monitor.identity ? "松开，仅设置此屏" : monitor.primary ? "主屏" : "拖到此处设置"}</small></strong>
          </div>)}
        </div>}
      </m.div>}
    </AnimatePresence>
  </div>, document.body);
}
