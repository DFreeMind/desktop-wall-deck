import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { Monitor, Position, Topology, Wallpaper } from "../lib/types";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { WallpaperGrid } from "../components/WallpaperGrid";
import { MonitorPanel } from "../components/MonitorPanel";
import { Toast, type ToastItem } from "../components/Toast";

/**
 * 主视图：三栏布局。
 *
 * 数据流是单向的：本组件持有所有状态，子组件只上报意图。
 * 壁纸操作全部经后端写系统，前端不回写「哪块屏用了哪张图」，
 * 而是在每次成功后重新拉取拓扑（后端会带回真实壁纸路径），
 * 避免前端状态与系统真实状态分叉——壁纸可能被系统设置或其他工具改动。
 */
export default function App() {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>("fill");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fitMessage, setFitMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [showVirtual, setShowVirtual] = useState(false);

  const notify = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, text, kind }]);
    // 4 秒后自动消失；用过滤器而不是索引，避免并发删除时错位
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const refreshTopology = useCallback(async () => {
    try {
      const t = await api.listMonitors();
      setTopology(t);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  const refreshLibrary = useCallback(async () => {
    try {
      setWallpapers(await api.libraryList());
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  useEffect(() => {
    void refreshTopology();
    void refreshLibrary();
  }, [refreshTopology, refreshLibrary]);

  // 后端导入完成会广播，这里跟随刷新
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("library://changed", () => void refreshLibrary());
    })();
    return () => unlisten?.();
  }, [refreshLibrary]);

  /** 可见显示器：虚拟屏默认折叠，避免模拟器/串流设备污染画布。 */
  const monitors = useMemo<Monitor[]>(() => {
    if (!topology) return [];
    return showVirtual
      ? topology.monitors
      : topology.monitors.filter((m) => m.kind !== "virtual");
  }, [topology, showVirtual]);

  const hiddenVirtualCount = useMemo(
    () => (topology ? topology.monitors.filter((m) => m.kind === "virtual").length : 0),
    [topology],
  );

  /** 每块屏当前壁纸。后端返回的是绝对路径，按 filePath 反查库内记录。 */
  const wallpaperMap = useMemo(() => {
    const byPath = new Map(wallpapers.map((w) => [normalize(w.filePath), w]));
    const map = new Map<string, Wallpaper>();
    // 注意：系统当前壁纸可能不来自本库（用户曾手动设置），
    // 这种情况找不到对应记录，画布显示占位色，属预期行为。
    for (const m of monitors) {
      if (m.currentWallpaper) {
        const hit = byPath.get(normalize(m.currentWallpaper));
        if (hit) map.set(m.identity, hit);
      }
    }
    return map;
  }, [monitors, wallpapers]);

  const activeWallpaper = useMemo(
    () => wallpapers.find((w) => w.id === activeId) ?? null,
    [wallpapers, activeId],
  );

  const activeIds = useMemo(() => {
    const s = new Set<string>();
    for (const w of wallpaperMap.values()) s.add(w.id);
    return s;
  }, [wallpaperMap]);

  // 选中变化时刷新比例提示，帮助用户在点「应用」前就知道会不会被裁
  useEffect(() => {
    if (!activeId || selected.size !== 1) {
      setFitMessage(null);
      return;
    }
    const identity = Array.from(selected)[0];
    void api
      .fitAdvice(activeId, identity)
      .then(([needsCrop, msg]) => setFitMessage(needsCrop ? msg : null))
      .catch(() => setFitMessage(null));
  }, [activeId, selected]);

  const toggleSelect = useCallback((identity: string, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (prev.has(identity) && additive) {
        next.delete(identity);
      } else {
        next.add(identity);
      }
      return next;
    });
  }, []);

  /** 执行壁纸设置，统一处理成功/失败反馈与刷新。 */
  const runApply = useCallback(
    async (fn: () => Promise<{ applied: number; skipped: string[] }>, okText: string) => {
      setBusy(true);
      try {
        const res = await fn();
        await refreshTopology();
        if (res.skipped.length > 0) {
          notify(`${okText}，${res.skipped.length} 项被跳过`, "warn");
        } else {
          notify(okText, "success");
        }
      } catch (e) {
        notify((e as Error).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [notify, refreshTopology],
  );

  const applyAll = useCallback(() => {
    if (!activeId) return;
    void runApply(
      () => api.applyWallpaper(activeId, { type: "all" }, position),
      "已应用到所有屏幕",
    );
  }, [activeId, position, runApply]);

  const applySelected = useCallback(() => {
    if (!activeId || selected.size === 0) return;
    const ids = Array.from(selected);
    void runApply(
      () => api.applyWallpaper(activeId, { type: "identities", value: ids }, position),
      `已应用到 ${ids.length} 块屏幕`,
    );
  }, [activeId, selected, position, runApply]);

  const applySpan = useCallback(() => {
    if (!activeId) return;
    void runApply(() => api.applySpan(activeId, position), "已按屏幕切分拼接");
  }, [activeId, position, runApply]);

  const handleDropWallpaper = useCallback(
    (wpId: string, identities: string[], applyAllFlag: boolean) => {
      setActiveId(wpId);
      if (applyAllFlag) {
        void runApply(
          () => api.applyWallpaper(wpId, { type: "all" }, position),
          "已应用到所有屏幕",
        );
        return;
      }
      void runApply(
        () => api.applyWallpaper(wpId, { type: "identities", value: identities }, position),
        `已应用到 ${identities.length} 块屏幕`,
      );
    },
    [position, runApply],
  );

  /** 点击壁纸：先选中，再按当前选择范围应用。 */
  const handleApplyWallpaper = useCallback(
    (w: Wallpaper) => {
      setActiveId(w.id);
      // 没有选屏时默认作用于全部，符合「点一下就换壁纸」的直觉
      if (selected.size === 0) {
        void runApply(
          () => api.applyWallpaper(w.id, { type: "all" }, position),
          `已将「${w.name}」应用到所有屏幕`,
        );
      } else {
        void runApply(
          () =>
            api.applyWallpaper(
              w.id,
              { type: "identities", value: Array.from(selected) },
              position,
            ),
          `已将「${w.name}」应用到 ${selected.size} 块屏幕`,
        );
      }
    },
    [position, runApply, selected],
  );

  const handleImport = useCallback(async () => {
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "图片",
            extensions: ["jpg", "jpeg", "png", "bmp", "gif", "webp", "tif", "tiff", "avif"],
          },
        ],
      });
      if (!picked) return;

      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;

      setImporting(true);
      const report = await api.libraryImport(paths);
      await refreshLibrary();

      const parts = [`新增 ${report.added} 张`];
      if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 张（已存在）`);
      if (report.failed.length > 0) parts.push(`失败 ${report.failed.length} 张`);

      notify(
        parts.join("，"),
        report.failed.length > 0 ? "warn" : "success",
      );
      if (report.failed.length > 0) {
        // 只展示首条失败原因，避免刷屏
        notify(`${report.failed[0].reason}`, "error");
      }
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setImporting(false);
    }
  }, [notify, refreshLibrary]);

  const handleDelete = useCallback(
    async (w: Wallpaper) => {
      try {
        await api.libraryRemove(w.id);
        if (activeId === w.id) setActiveId(null);
        await refreshLibrary();
        notify(`已从库中移除「${w.name}」`, "info");
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [activeId, notify, refreshLibrary],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          桌面壁纸
        </div>
        <div className="topbar-actions">
          {hiddenVirtualCount > 0 && (
            <label className="toggle">
              <input
                type="checkbox"
                checked={showVirtual}
                onChange={(e) => setShowVirtual(e.target.checked)}
              />
              显示 {hiddenVirtualCount} 块虚拟屏
            </label>
          )}
          <button className="ghost" onClick={() => void refreshTopology()}>
            刷新显示器
          </button>
        </div>
      </header>

      <main className="body">
        <section className="stage">
          <div className="stage-head">
            <h1>显示器布局</h1>
            <span className="dim">
              按系统实际排列绘制 · 拖拽壁纸到屏幕上可直接设置
            </span>
          </div>
          <TopologyCanvas
            topology={topology ? { ...topology, monitors } : null}
            wallpaperMap={wallpaperMap}
            selected={selected}
            onToggleSelect={toggleSelect}
            onDropWallpaper={handleDropWallpaper}
            draggingId={draggingId}
          />
          {selected.size > 0 && (
            <div className="selection-bar">
              已选 {selected.size} 块屏
              <button className="ghost" onClick={() => setSelected(new Set())}>
                清除选择
              </button>
            </div>
          )}

          <WallpaperGrid
            wallpapers={wallpapers}
            activeIds={activeIds}
            onDragStart={setDraggingId}
            onDragEnd={() => setDraggingId(null)}
            onApply={handleApplyWallpaper}
            onDelete={handleDelete}
            onImport={() => void handleImport()}
            importing={importing}
          />
        </section>

        <MonitorPanel
          monitors={monitors}
          selected={selected}
          wallpapers={wallpapers}
          activeWallpaper={activeWallpaper}
          position={position}
          onPositionChange={setPosition}
          fitMessage={fitMessage}
          onApplyAll={applyAll}
          onApplySelected={applySelected}
          onApplySpan={applySpan}
          busy={busy}
        />
      </main>

      <Toast items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

/** 路径规范化，用于跨大小写与分隔符比较（Windows 路径大小写不敏感）。 */
function normalize(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}
