import type { WallpaperApplyBarProps } from "./WallpaperApplyBar";
import { WallpaperApplyBar } from "./WallpaperApplyBar";
import { IconMonitor } from "./icons";
import { assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import "../styles/displayApplyPanel.css";

export type DisplayApplyPanelProps = WallpaperApplyBarProps;

export function DisplayApplyPanel({ compact = false, ...props }: DisplayApplyPanelProps) {
  const revision = useThumbnailRevision();
  const wallpaper = props.pendingWallpaper;
  const thumbnail = wallpaper ? assetUrl(wallpaper.thumbPath, thumbnailVersion(revision, wallpaper.id)) : undefined;
  return (
    <aside className={`display-apply-panel${compact ? " is-compact" : ""}${wallpaper ? " has-wallpaper" : " is-empty"}`} aria-label="壁纸投放设置">
      {!wallpaper ? (
        <div className="display-apply-empty" role="status">
          <span className="display-apply-empty-icon"><IconMonitor size={22} /></span>
          <strong>未选择壁纸</strong>
          <span>从图库选择一张壁纸后即可设置投放目标。</span>
        </div>
      ) : (
        <div className="display-apply-summary">
          <img src={thumbnail} alt="" decoding="async" />
          <div className="display-apply-summary-copy">
            <span className="display-apply-summary-label">待应用壁纸</span>
            <strong title={wallpaper.name}>{wallpaper.name}</strong>
            <span>{wallpaper.width} × {wallpaper.height}</span>
          </div>
        </div>
      )}
      <WallpaperApplyBar {...props} compact inlineNote />
    </aside>
  );
}
