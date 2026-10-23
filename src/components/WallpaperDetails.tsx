import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { m, useReducedMotion } from "motion/react";
import type { Wallpaper, WallpaperDetails as WallpaperDetailsData } from "../lib/types";
import { api, assetUrl } from "../lib/api";
import { thumbnailVersion, useThumbnailRevision } from "../hooks/useThumbnailRevision";
import { IconClose, IconExternal, IconFolder, IconRefresh } from "./icons";
import "../styles/wallpaperDetails.css";

interface Props {
  wallpaper: Wallpaper;
  onClose: () => void;
  onRelink: (wallpaper: Wallpaper) => void;
}

const focusableSelector = [
  "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)",
  "textarea:not(:disabled)", "a[href]", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 展示单张壁纸在索引中的文件元数据；不读取或修改原文件。 */
export function WallpaperDetails({ wallpaper, onClose, onRelink }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState<WallpaperDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const revisions = useThumbnailRevision();
  const currentDetails = details?.id === wallpaper.id ? details : null;
  const isLoading = loading || (!currentDetails && !loadError);
  const exists = currentDetails?.exists ?? !wallpaper.missing;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDetails(null);
    setRevealError(null);
    void api.wallpaperDetails(wallpaper.id).then((value) => {
      if (!cancelled) setDetails(value);
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [wallpaper.id, attempt]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const previousRootInert = root?.inert ?? false;
    const dialog = dialogRef.current;
    const coveredDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"))
      .filter((element) => element !== dialog && !element.contains(dialog))
      .map((element) => ({ element, inert: element.inert }));

    if (root) root.inert = true;
    coveredDialogs.forEach(({ element }) => { element.inert = true; });
    closeRef.current?.focus({ preventScroll: true });

    return () => {
      if (root) root.inert = previousRootInert;
      coveredDialogs.forEach(({ element, inert }) => { element.inert = inert; });
      if (previousFocus?.isConnected) {
        requestAnimationFrame(() => {
          if (previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopmostDialog(dialog)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture runs before the preview's document-level bubbling Escape handler.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const reveal = async () => {
    if (revealing || isLoading || !currentDetails) return;
    setRevealing(true);
    setRevealError(null);
    try {
      await api.revealWallpaper(wallpaper.id);
    } catch (error) {
      setRevealError(errorMessage(error));
    } finally {
      setRevealing(false);
    }
  };

  const fileName = currentDetails?.fileName ?? fileNameFromPath(wallpaper.filePath) ?? wallpaper.name;

  return createPortal(
    <m.div
      className="wallpaper-details-backdrop"
      initial={{ opacity: reducedMotion ? 1 : 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: reducedMotion ? 1 : 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <m.section
        ref={dialogRef}
        className="wallpaper-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`壁纸详情：${fileName}`}
        tabIndex={-1}
        initial={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 8, scale: reducedMotion ? 1 : 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 5, scale: reducedMotion ? 1 : 0.995 }}
        transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
        aria-busy={isLoading}
      >
        <header className="wallpaper-details-head">
          <div className="wallpaper-details-heading">
            <span>壁纸信息</span>
            <strong title={fileName}>{fileName}</strong>
          </div>
          <span className={`wallpaper-details-exists${exists ? " is-present" : " is-missing"}`}>
            <span aria-hidden="true" />{exists ? "文件可用" : "文件缺失"}
          </span>
          <button ref={closeRef} className="wallpaper-details-close" onClick={onClose} aria-label="关闭壁纸详情" title="关闭（Esc）">
            <IconClose size={18} />
          </button>
        </header>

        <div className="wallpaper-details-content">
          <section className="wallpaper-details-overview" aria-label="壁纸预览">
            <div className="wallpaper-details-image-frame">
              <img
                src={assetUrl(wallpaper.thumbPath, thumbnailVersion(revisions, wallpaper.id))}
                alt=""
                draggable={false}
              />
            </div>
            <div className="wallpaper-details-overview-copy">
              <div className="wallpaper-details-status-line">
                <strong>{currentDetails?.name ?? wallpaper.name}</strong>
                <span className={`wallpaper-details-pill${exists ? " is-present" : " is-missing"}`}>{exists ? "存在" : "已丢失"}</span>
              </div>
              <span className="wallpaper-details-dimensions">
                {currentDetails ? `${currentDetails.width} × ${currentDetails.height}` : `${wallpaper.width} × ${wallpaper.height}`}
              </span>
              <div className="wallpaper-details-actions">
                <button className="wallpaper-details-action" onClick={() => void reveal()} disabled={isLoading || revealing || !currentDetails}>
                  <IconFolder size={15} />{revealing ? "正在打开…" : exists ? "在文件夹中显示" : "打开所在文件夹"}
                </button>
                {!exists && (
                  <button className="wallpaper-details-action is-primary" onClick={() => onRelink(wallpaper)}>
                    <IconRefresh size={15} />重新定位文件
                  </button>
                )}
                {currentDetails?.exists === false && <span className="wallpaper-details-missing-hint">定位后会保留当前索引与合集。</span>}
              </div>
              {revealError && <p className="wallpaper-details-inline-error" role="alert">无法打开所在文件夹：{revealError}</p>}
            </div>
          </section>

          {isLoading ? (
            <div className="wallpaper-details-message" role="status"><span className="spinner" />正在读取文件信息…</div>
          ) : loadError ? (
            <div className="wallpaper-details-error" role="alert">
              <strong>读取壁纸信息失败</strong>
              <span>{loadError}</span>
              <button className="wallpaper-details-action" onClick={() => setAttempt((value) => value + 1)}><IconRefresh size={15} />重试</button>
            </div>
          ) : currentDetails ? (
            <>
              <section className="wallpaper-details-section" aria-labelledby="wallpaper-details-file-heading">
                <h3 id="wallpaper-details-file-heading">文件属性</h3>
                <div className="wallpaper-details-facts">
                  <Fact label="文件大小" value={formatBytes(currentDetails.bytes)} />
                  <Fact label="图片尺寸" value={`${currentDetails.width} × ${currentDetails.height} 像素`} />
                  <Fact label="文件格式" value={currentDetails.extension ? currentDetails.extension.toUpperCase().replace(/^\./, "") : "未知"} />
                  <Fact label="存储方式" value={currentDetails.storageKind === "indexed" ? "索引本机原图" : "应用托管副本"} />
                </div>
              </section>

              <section className="wallpaper-details-section" aria-labelledby="wallpaper-details-time-heading">
                <h3 id="wallpaper-details-time-heading">时间信息</h3>
                <div className="wallpaper-details-facts">
                  <Fact label="文件创建时间" value={formatTimestamp(currentDetails.fileCreatedAt)} />
                  <Fact label="文件修改时间" value={formatTimestamp(currentDetails.fileModifiedAt)} />
                  <Fact label="加入壁纸库" value={formatTimestamp(currentDetails.indexedAt)} />
                </div>
              </section>

              <section className="wallpaper-details-section wallpaper-details-path-section" aria-labelledby="wallpaper-details-path-heading">
                <h3 id="wallpaper-details-path-heading">文件位置</h3>
                <div className="wallpaper-details-path-row">
                  <span>完整路径</span>
                  <code title={currentDetails.filePath}>{currentDetails.filePath || "未知"}</code>
                </div>
                <div className="wallpaper-details-path-row">
                  <span>所在目录</span>
                  <code title={currentDetails.parentPath}>{currentDetails.parentPath || "未知"}</code>
                </div>
                {!currentDetails.exists && <p className="wallpaper-details-path-note">当前文件不可访问；显示的是索引中保存的原始路径。</p>}
              </section>
            </>
          ) : null}
        </div>

        <footer className="wallpaper-details-footer">
          <span><IconExternal size={14} />{exists ? "本机原图保持原位" : "文件暂不可用，索引信息仍保留"}</span>
          <button onClick={onClose}>完成</button>
        </footer>
      </m.section>
    </m.div>,
    document.body,
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="wallpaper-details-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未知";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameFromPath(path: string): string | null {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1];
  return name || null;
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  return dialogs[dialogs.length - 1] === dialog;
}
