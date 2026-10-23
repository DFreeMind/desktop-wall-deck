import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, invalidateLibraryReads } from "../lib/api";
import "../lib/theme";
import "../styles/theme.css";
import type {
  FolderNode,
  FolderScan,
  LibraryScope,
  Monitor,
  OnlineWallpaper,
  Position,
  Topology,
  Wallpaper,
} from "../lib/types";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { WallpaperGrid } from "../components/WallpaperGrid";
import { WallpaperPreview } from "../components/WallpaperPreview";
import { WallpaperDetails } from "../components/WallpaperDetails";
import { WallpaperDragLayer } from "../components/WallpaperDragLayer";
import { useWallpaperDrag } from "../hooks/useWallpaperDrag";
import { useExternalFileDrop } from "../hooks/useExternalFileDrop";
import { ExternalFileDropLayer } from "../components/ExternalFileDropLayer";
import "../styles/wallpaperDrag.css";
import { DisplayApplyPanel } from "../components/DisplayApplyPanel";
import { WallpaperApplyBar } from "../components/WallpaperApplyBar";
import "../styles/workspace.css";
import { SideNav, type NavView } from "../components/SideNav";
import {
  ConfirmDialog,
  FolderImportDialog,
  MoveDialog,
  PromptDialog,
} from "../components/dialogs";
import { Toast, type ToastItem } from "../components/Toast";
import { SourcesView } from "./SourcesView";
import { SettingsView } from "./SettingsView";
import { CollectionsView } from "./CollectionsView";
import { IconChevron, IconRefresh } from "../components/icons";
import { useScreenWallpapers } from "../hooks/useScreenWallpapers";

/**
 * 主视图：图库 / 多屏工作台 / 沉浸预览，共用选择与投放状态。
 *
 * 数据流是单向的：本组件持有所有状态，子组件只上报意图。
 * 壁纸操作全部经后端写系统，前端不回写「哪块屏用了哪张图」，
 * 而是在每次成功后重新拉取拓扑（后端会带回真实壁纸路径），
 * 避免前端状态与系统真实状态分叉——壁纸可能被系统设置或其他工具改动。
 *
 * 弹窗（新建合集 / 重命名 / 移动 / 删除确认）统一由 `dialog` 状态驱动，
 * 不用嵌套组件各自持有：一次只能有一个弹窗，用状态机比多个布尔量更不容易出错。
 */

type Dialog =
  | { kind: "none" }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "rename-folder"; id: string; name: string }
  | { kind: "move"; wallpaper: Wallpaper }
  | { kind: "delete-folder"; id: string; name: string; total: number }
  | { kind: "delete-wallpaper"; wallpaper: Wallpaper }
  | { kind: "import-folder" };

const loadMotionFeatures = () => import("../lib/motionFeatures").then((module) => module.default);

export default function App() {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const libraryRequest = useRef(0);
  const topologyRequest = useRef(0);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [view, setView] = useState<NavView>("library");
  const [scope, setScope] = useState<LibraryScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsReturnFocus = useRef<HTMLElement | null>(null);
  const openDetails = useCallback((wallpaper: Wallpaper) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    detailsReturnFocus.current = focused?.closest("[role=dialog]") ? focused
      : document.querySelector<HTMLElement>(`.card[data-wallpaper-id="${CSS.escape(wallpaper.id)}"]`);
    setDetailsId(wallpaper.id);
  }, []);
  const closeDetails = useCallback(() => setDetailsId(null), []);
  const [layoutMode, setLayoutMode] = useState<"expanded" | "hidden">("expanded");
  const closePreview = useCallback(() => setPreviewId(null), []);
  const openPreview = useCallback((wallpaper: Wallpaper) => { setActiveId(wallpaper.id); setPreviewId(wallpaper.id); }, []);
  const navigatePreview = useCallback((id: string) => { setActiveId(id); setPreviewId(id); }, []);
  const reducedMotion = useReducedMotion();
  const [position, setPosition] = useState<Position>("fill");
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const applyLock = useRef(false);
  const [fitMessage, setFitMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [showVirtual, setShowVirtual] = useState(() => {
    try { return localStorage.getItem("wall-deck.show-virtual.v1") === "true"; } catch { return false; }
  });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });

  /** 添加本机文件夹的临时状态：路径、扫描结果、目标合集 */
  const [pickPath, setPickPath] = useState("");
  const [pickScan, setPickScan] = useState<FolderScan | null>(null);
  const [pickScanning, setPickScanning] = useState(false);
  const [pickTarget, setPickTarget] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const notify = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, text, kind }]);
    // 4 秒后自动消失；用过滤器而不是索引，避免并发删除时错位
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const refreshTopology = useCallback(async () => {
    const request = ++topologyRequest.current;
    try {
      const result = await api.listMonitors();
      if (request === topologyRequest.current) setTopology(result);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  const changeShowVirtual = useCallback((value: boolean) => {
    setShowVirtual(value);
    try { localStorage.setItem("wall-deck.show-virtual.v1", String(value)); }
    catch { notify("显示偏好已在本次会话生效，但未能保存", "warn"); }
  }, [notify]);

  /** 分别展示已返回的数据，不能让合集或显示器的慢请求拖住壁纸首屏。 */
  const refreshAll = useCallback(async () => {
    const request = ++libraryRequest.current;
    const results = await Promise.allSettled([
      api.libraryList().then((list) => { if (request === libraryRequest.current) setWallpapers(list); })
        .finally(() => { if (request === libraryRequest.current) setLibraryReady(true); }),
      api.folderTree().then((tree) => { if (request === libraryRequest.current) setFolders(tree); }),
    ]);
    if (request === libraryRequest.current) for (const result of results) if (result.status === "rejected") notify(String(result.reason), "error");
  }, [notify]);

  useEffect(() => {
    void refreshTopology();
    void refreshAll();
  }, [refreshTopology, refreshAll]);

  // 后端写操作后广播，这里跟随刷新
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      for (const event of ["library://changed", "library://thumbnails-repaired"]) {
        const off = await listen<string[]>(event, ({ payload }) => {
          if (disposed) return;
          if (event === "library://thumbnails-repaired") {
            window.dispatchEvent(new CustomEvent("wallpaper-thumbnails-repaired", { detail: payload }));
          } else {
            invalidateLibraryReads();
            void refreshAll();
          }
        });
        if (disposed) off(); else unlisteners.push(off);
      }
    })();
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [refreshAll]);

  /** 可见显示器：虚拟屏默认折叠，避免模拟器/串流设备污染画布。 */
  const monitors = useMemo<Monitor[]>(() => {
    if (!topology) return [];
    return showVirtual
      ? topology.monitors
      : topology.monitors.filter((m) => m.kind !== "virtual");
  }, [topology, showVirtual]);

  const virtualCount = useMemo(
    () => (topology ? topology.monitors.filter((m) => m.kind === "virtual").length : 0),
    [topology],
  );

  // 隐藏虚拟屏后重新计算可见屏幕的边界，避免为屏外设备保留大片空白。
  const visibleTopology = useMemo(() => {
    if (!topology) return null;
    if (!monitors.length) return { ...topology, monitors };
    return { monitors, bounds: {
      left: Math.min(...monitors.map((m) => m.rect.left)),
      top: Math.min(...monitors.map((m) => m.rect.top)),
      right: Math.max(...monitors.map((m) => m.rect.right)),
      bottom: Math.max(...monitors.map((m) => m.rect.bottom)),
    } };
  }, [topology, monitors]);

  // 断开或隐藏的屏幕不继续充当目标，避免界面数量与实际请求不一致。
  useEffect(() => {
    const visible = new Set(monitors.map((m) => m.identity));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [monitors]);

  /**
   * 每块屏当前实际展示的壁纸。
   *
   * 系统壁纸未必来自本库（用户可能用系统设置换过图），
   * 因此由 hook 同时处理「库里命中」与「库外解码预览」两条路径。
   */
  const screenWallpapers = useScreenWallpapers(monitors, wallpapers, libraryReady);

  const folderById = useMemo(() => {
    const map = new Map<string, FolderNode>();
    for (const f of folders) map.set(f.id, f);
    return map;
  }, [folders]);

  /** 当前范围下的壁纸。合集范围在前端过滤，避免每次切换都打一次后端。 */
  const scopedWallpapers = useMemo(() => {
    if (scope.kind === "all") return wallpapers;
    if (scope.kind === "unfiled") return wallpapers.filter((w) => !w.folderId);
    const ids = scope.recursive ? collectSubtree(folders, scope.id) : new Set([scope.id]);
    return wallpapers.filter((w) => w.folderId && ids.has(w.folderId));
  }, [scope, wallpapers, folders]);

  const unfiledCount = useMemo(
    () => wallpapers.filter((w) => !w.folderId).length,
    [wallpapers],
  );

  const activeWallpaper = useMemo(
    () => wallpapers.find((w) => w.id === activeId) ?? null,
    [wallpapers, activeId],
  );
  const previewWallpaper = wallpapers.find((w) => w.id === previewId);
  const detailsWallpaper = wallpapers.find((w) => w.id === detailsId);
  const previewItems = view === "library" && scopedWallpapers.some((w) => w.id === previewId)
    ? scopedWallpapers : wallpapers;

  /** 正在被某块屏使用的库内壁纸 id，用于在卡片上打「使用中」角标。 */
  const activeIds = useMemo(() => {
    const s = new Set<string>();
    for (const w of screenWallpapers.values()) {
      if (w.kind === "library") s.add(w.wallpaper.id);
    }
    return s;
  }, [screenWallpapers]);

  const screenLabels = useMemo(() => {
    const labels = new Map<string, string[]>();
    const primary = monitors.find(m => m.primary);
    for (const monitor of monitors) {
      const current = screenWallpapers.get(monitor.identity);
      if (current?.kind !== "library") continue;
      const label = monitor.primary ? "主屏" : primary && monitor.rect.left < primary.rect.left ? "左屏" : primary && monitor.rect.left > primary.rect.left ? "右屏" : monitor.name;
      labels.set(current.wallpaper.id, [...(labels.get(current.wallpaper.id) ?? []), label]);
    }
    return labels;
  }, [monitors, screenWallpapers]);

  // 选中变化时刷新比例提示，帮助用户在点「应用」前就知道会不会被裁
  useEffect(() => {
    if (!activeId || selected.size !== 1) {
      setFitMessage(null);
      return;
    }
    const identity = Array.from(selected)[0];
    let cancelled = false;
    void api
      .fitAdvice(activeId, identity)
      .then(([needsCrop, msg]) => { if (!cancelled) setFitMessage(needsCrop ? msg : null); })
      .catch(() => { if (!cancelled) setFitMessage(null); });
    return () => { cancelled = true; };
  }, [activeId, selected, monitors]);

  const toggleSelect = useCallback((identity: string, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (prev.has(identity) && (additive || prev.size === 1)) {
        next.delete(identity);
      } else {
        next.add(identity);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (view !== "display") return;
    setSelected(previous => previous.size ? previous : new Set(monitors.length ? [(monitors.find(m => m.primary) ?? monitors[0]).identity] : []));
  }, [view, monitors]);

  /** 执行壁纸设置，统一处理成功/失败反馈与刷新。 */
  const runApply = useCallback(
    async (fn: () => Promise<{ applied: number; skipped: string[] }>, okText: string) => {
      if (applyLock.current) return;
      applyLock.current = true;
      setBusy(true);
      try {
        const res = await fn();
        await Promise.all([refreshAll(), refreshTopology()]);
        if (res.applied === 0) {
          notify("没有应用到任何显示器，请刷新后重新选择目标", "warn");
        } else if (res.skipped.length > 0) {
          notify(`已应用到 ${res.applied} 块屏幕，${res.skipped.length} 项被跳过`, "warn");
        } else {
          notify(okText, "success");
        }
      } catch (e) {
        notify((e as Error).message, "error");
      } finally {
        applyLock.current = false;
        setBusy(false);
      }
    },
    [notify, refreshAll, refreshTopology],
  );

  const applyAll = useCallback(() => {
    if (!activeId) return;
    void runApply(
      () =>
        api.applyWallpaper(
          activeId,
          { type: "all", value: { includeVirtual: showVirtual } },
          position,
        ),
      "已应用到所有屏幕",
    );
  }, [activeId, position, runApply, showVirtual]);

  const applySelected = useCallback(() => {
    if (!activeId || selected.size === 0) return;
    const ids = monitors.filter((m) => selected.has(m.identity)).map((m) => m.identity);
    if (!ids.length) return;
    void runApply(
      () => api.applyWallpaper(activeId, { type: "identities", value: ids }, position),
      `已应用到 ${ids.length} 块屏幕`,
    );
  }, [activeId, selected, monitors, position, runApply]);

  const applySpan = useCallback(() => {
    if (!activeId) return;
    void runApply(() => api.applySpan(activeId), "已按屏幕切分拼接");
  }, [activeId, runApply]);

  const handleDropWallpaper = useCallback(async (wallpaper: Wallpaper, identities: string[]) => {
    if (applyLock.current) throw new Error("正在应用壁纸，请稍候");
    const currentWallpaper = wallpapers.find((item) => item.id === wallpaper.id);
    if (!currentWallpaper || currentWallpaper.missing) throw new Error("原文件不可用，请先重新定位");
    if (position === "tile") throw new Error("平铺会影响所有屏幕，请切换为填充或适应后拖放");
    const targets = monitors.filter((monitor) => identities.includes(monitor.identity)).map((monitor) => monitor.identity);
    if (!targets.length) throw new Error("目标显示器已断开，请刷新显示器");
    applyLock.current = true;
    setBusy(true);
    setActiveId(wallpaper.id);
    setSelected(new Set(targets));
    try {
      const result = await api.applyWallpaper(wallpaper.id, { type: "identities", value: targets }, position);
      await Promise.all([refreshAll(), refreshTopology()]);
      if (!result.applied) throw new Error("显示器已断开，未应用壁纸");
      if (result.skipped.length) return `已设置 ${result.applied} 块屏幕；${result.skipped.length} 块屏幕已断开`;
      const target = monitors.find((monitor) => monitor.identity === targets[0]);
      return targets.length === 1 ? `已设置到${target?.name ?? "目标屏幕"}` : `已设置到 ${result.applied} 块屏幕`;
    } finally {
      applyLock.current = false;
      setBusy(false);
    }
  }, [monitors, position, refreshAll, refreshTopology, wallpapers]);

  const wallpaperDrag = useWallpaperDrag({
    monitors, selected, busy: busy || importing, onApply: handleDropWallpaper, onNotify: notify,
    disabledReason: position === "tile" ? "平铺模式不支持单屏拖放，请先切换为填充或适应" : monitors.length ? null : "未检测到可投放的显示器",
  });
  const draggingId = wallpaperDrag.state?.phase === "dragging" ? wallpaperDrag.state.wallpaper.id : null;

  const handleExternalDrop = useCallback(async (paths: string[], targetId: string | null) => {
    if (applyLock.current || importing) throw new Error("正在处理图片，请稍候");
    if (targetId && (position === "tile" || !monitors.some((monitor) => monitor.identity === targetId))) {
      throw new Error(position === "tile" ? "平铺不支持单屏投放" : "目标显示器已断开，请刷新显示器");
    }
    applyLock.current = true;
    setImporting(true);
    setBusy(true);
    let imported: Wallpaper | null = null;
    const folderId = view === "library" && scope.kind === "folder" ? scope.id : null;
    try {
      if (!targetId) {
        const report = await api.libraryImport(paths, folderId);
        await refreshAll();
        if (report.failed.length) throw new Error(`新增 ${report.added} 张、更新 ${report.updated} 张；${report.failed.length} 张未能索引：${report.failed[0].reason}`);
        return `已加入壁纸库：新增 ${report.added} 张、更新 ${report.updated} 张、已存在 ${report.skipped} 张 · 未修改桌面`;
      }
      if (paths.length !== 1) throw new Error("设置屏幕时请一次拖入一张图片");
      imported = await api.libraryImportFile(paths[0], folderId);
      const wallpaper = imported;
      setWallpapers((items) => [...items.filter((item) => item.id !== wallpaper.id), wallpaper]);
      setActiveId(wallpaper.id);
      setSelected(new Set([targetId]));
      const result = await api.applyWallpaper(wallpaper.id, { type: "identities", value: [targetId] }, position);
      await Promise.all([refreshAll(), refreshTopology()]);
      if (!result.applied) throw new Error("目标显示器已断开，未设置壁纸");
      return `已索引并设置到${monitors.find((monitor) => monitor.identity === targetId)?.name ?? "落点屏幕"} · 原文件保持原位`;
    } catch (error) {
      if (imported) {
        await refreshAll();
        throw new Error(`图片已加入壁纸库，但设置失败：${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      applyLock.current = false;
      setImporting(false);
      setBusy(false);
    }
  }, [importing, position, monitors, view, scope, refreshAll, refreshTopology]);

  const externalDrop = useExternalFileDrop({
    enabled: (view === "library" || view === "display") && dialog.kind === "none" && !previewWallpaper && !detailsWallpaper,
    busy: busy || importing || !!wallpaperDrag.state,
    tile: position === "tile", monitors, onDrop: handleExternalDrop, onNotify: notify,
  });

  /** 浏览壁纸不修改桌面，只有应用按钮或拖放才执行投放。 */
  const handleSelectWallpaper = useCallback((w: Wallpaper, toggle = false) => {
    setActiveId(current => toggle && current === w.id ? null : w.id);
  }, []);

  const handleRefreshIndex = useCallback(async () => {
    setImporting(true);
    try {
      const report = await api.libraryRefresh();
      await refreshAll();
      notify(`索引已刷新：新增 ${report.added} 张，更新 ${report.updated ?? 0} 张`, report.failed.length ? "warn" : "success");
      if (report.failed.length) notify(report.failed[0].reason, "error");
    } catch (error) { notify((error as Error).message, "error"); }
    finally { setImporting(false); }
  }, [notify, refreshAll]);

  const handleRelink = useCallback(async (wallpaper: Wallpaper) => {
    try {
      const path = await open({ multiple: false, directory: false, title: `重新定位「${wallpaper.name}」`,
        filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff", "avif"] }] });
      if (!path || Array.isArray(path)) return;
      await api.libraryRelink(wallpaper.id, path);
      await refreshAll();
      notify("已更新原文件位置，合集与显示名保持不变", "success");
    } catch (error) { notify((error as Error).message, "error"); }
  }, [notify, refreshAll]);

  /** 导入：会把图片归入当前浏览的合集。根目录范围导入到根。 */
  const handleImport = useCallback(async () => {
    const targetFolder =
      view === "library" && scope.kind === "folder" ? scope.id : null;

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
      const report = await api.libraryImport(paths, targetFolder);
      await refreshAll();

      const parts = [`新增 ${report.added} 张`];
      if (report.updated) parts.push(`更新 ${report.updated} 张`);
      if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 张（已存在）`);
      if (report.failed.length > 0) parts.push(`失败 ${report.failed.length} 张`);

      notify(parts.join("，"), report.failed.length > 0 ? "warn" : "success");
      if (report.failed.length > 0) {
        // 只展示首条失败原因，避免刷屏
        notify(report.failed[0].reason, "error");
      }
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setImporting(false);
    }
  }, [notify, refreshAll, scope, view]);

  // ---------------- 添加本机文件夹 ----------------

  /** 打开「添加本机文件夹」弹窗，默认归入当前浏览的合集。 */
  const openFolderImport = useCallback(() => {
    setPickPath("");
    setPickScan(null);
    setPickError(null);
    setPickTarget(view === "library" && scope.kind === "folder" ? scope.id : null);
    setDialog({ kind: "import-folder" });
  }, [scope, view]);

  const chooseFolder = useCallback(async () => {
    setPickError(null);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      setPickPath(picked);
      setPickScan(null);
      setPickScanning(true);
      try {
        setPickScan(await api.libraryScanFolder(picked));
      } catch (e) {
        setPickError((e as Error).message);
      } finally {
        setPickScanning(false);
      }
    } catch (e) {
      setPickError((e as Error).message);
    }
  }, []);

  const runFolderImport = useCallback(async () => {
    if (!pickPath) return;
    setImporting(true);
    setPickError(null);
    try {
      const report = await api.libraryImportFolder(pickPath, pickTarget);
      await refreshAll();

      const parts = [`新增 ${report.added} 张`];
      if (report.updated) parts.push(`更新 ${report.updated} 张`);
      if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 张（已在库中）`);
      if (report.failed.length > 0) parts.push(`失败 ${report.failed.length} 张`);
      notify(parts.join("，"), report.failed.length > 0 ? "warn" : "success");
      if (report.failed.length > 0) notify(report.failed[0].reason, "error");

      setDialog({ kind: "none" });
      // 导入完成后切到目标合集，让用户立刻看到结果
      if (pickTarget) {
        setScope({ kind: "folder", id: pickTarget, recursive: true });
      } else {
        setScope({ kind: "all" });
      }
      setView("library");
    } catch (e) {
      setPickError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [notify, pickPath, pickTarget, refreshAll]);

  // ---------------- 合集操作 ----------------

  const submitNewFolder = useCallback(
    async (name: string, parentId: string | null) => {
      const created = await api.folderCreate(name, parentId);
      setDialog({ kind: "none" });
      await refreshAll();
      // 管理页保留当前位置，分类侧栏创建后打开新合集以便导入图片。
      if (view !== "collections") {
        setScope({ kind: "folder", id: created.id, recursive: true });
        setView("library");
      }
      notify(`已新建合集「${name}」`, "success");
    },
    [notify, refreshAll, view],
  );

  const submitRenameFolder = useCallback(
    async (id: string, name: string) => {
      await api.folderRename(id, name);
      setDialog({ kind: "none" });
      await refreshAll();
    },
    [refreshAll],
  );

  const submitDeleteFolder = useCallback(
    async (id: string) => {
      setDialog({ kind: "none" });
      try {
        await api.folderDelete(id);
        await refreshAll();
        // 删掉的正是当前浏览的合集时，退回全部，避免出现空视图
        if (scope.kind === "folder" && scope.id === id) setScope({ kind: "all" });
        notify("合集已删除，其中的壁纸已移到上一级", "info");
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [notify, refreshAll, scope],
  );

  const submitMove = useCallback(
    async (wp: Wallpaper, folderId: string | null) => {
      setDialog({ kind: "none" });
      try {
        await api.libraryMoveToFolder(wp.id, folderId);
        await refreshAll();
        const name = folderId ? folderById.get(folderId)?.name ?? "合集" : "库根目录";
        notify(`「${wp.name}」已移动到${name}`, "success");
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [folderById, notify, refreshAll],
  );

  const submitDeleteWallpaper = useCallback(
    async (wp: Wallpaper) => {
      setDialog({ kind: "none" });
      try {
        await api.libraryRemove(wp.id);
        if (activeId === wp.id) setActiveId(null);
        await refreshAll();
        notify(`已从库中移除「${wp.name}」`, "info");
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [activeId, notify, refreshAll],
  );

  // ---------------- 范围描述文案 ----------------

  const scopeTitle = useMemo(() => {
    if (scope.kind === "all") return "壁纸库";
    if (scope.kind === "unfiled") return "未归类";
    return folderById.get(scope.id)?.name ?? "合集";
  }, [scope, folderById]);

  const scopeHint = useMemo(() => {
    if (scope.kind === "all") return "全部壁纸，含所有合集内的图片";
    if (scope.kind === "unfiled") return "还没有归入任何合集的壁纸";
    const node = folderById.get(scope.id);
    if (!node) return "";
    const sub = node.children.length;
    return sub > 0
      ? `含 ${sub} 个子合集，共 ${node.totalCount} 张（本层 ${node.directCount} 张）`
      : `共 ${node.totalCount} 张`;
  }, [scope, folderById]);

  const importLabel = scope.kind === "folder" ? "添加到此合集" : "添加图片";

  const importOnline = async (item: OnlineWallpaper, apply: boolean) => {
    const result = await api.onlineImport(item.source, item.id);
    await refreshAll();
    if (apply) {
      const target = selected.size > 0
        ? { type: "identities" as const, value: Array.from(selected) }
        : { type: "all" as const, value: { includeVirtual: showVirtual } };
      const applied = await api.applyWallpaper(result.wallpaper.id, target, position);
      await refreshTopology();
      notify(applied.skipped.length ? `已应用到 ${applied.applied} 块屏幕，${applied.skipped.length} 项被跳过` : `已应用到 ${applied.applied} 块屏幕`, applied.skipped.length ? "warn" : "success");
    } else {
      notify(result.added ? "已加入壁纸库，可离线使用" : "这张图片已在壁纸库中", "success");
    }
  };

  const displayPanelProps = {
    monitors, selected, wallpaperMap: screenWallpapers, pendingWallpaper: activeWallpaper,
    onPreview: openPreview, onRelink: (wallpaper: Wallpaper) => void handleRelink(wallpaper),
    position, onPositionChange: setPosition, fitMessage, onApplyAll: applyAll,
    onApplySelected: applySelected, onApplySpan: applySpan, busy,
    onClearSelection: () => setSelected(new Set<string>()), onToggleSelect: toggleSelect,
    onRefresh: () => void refreshTopology(),
  };

  return (
    <LazyMotion features={loadMotionFeatures} strict><MotionConfig reducedMotion="user"><div className="app">
      <div className={`shell workspace-shell${view === "display" ? " workspace-display" : ""}`}>
        <SideNav
          view={view}
          compact={false}
          onViewChange={setView}
          scope={scope}
          onScopeChange={setScope}
          folders={folders}
          totalCount={wallpapers.length}
          unfiledCount={unfiledCount}
          monitorCount={monitors.length}
          onCreateFolder={(parentId) => setDialog({ kind: "new-folder", parentId })}
        />

        <main className="content">
          <AnimatePresence mode="wait" initial={false}>
          <m.div key={view} className={`workspace-page workspace-page-${view}`}
            initial={{ opacity: 0, y: reducedMotion ? 0 : 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
            transition={{ duration: reducedMotion ? 0 : .16, ease: [.22, 1, .36, 1] }}>
          {view === "display" && (
            <div className="display-page">
              <div className="canvas-wrap">
                <div className="canvas-head">
                  <div className="canvas-head-main">
                    <h1>显示器布局</h1>
                    <span className="canvas-head-sub">
                      {wallpaperDrag.state?.phase === "dragging" ? wallpaperDrag.state.message : `${monitors.length} 台已连接 · 拖入图片可直接应用`}
                    </span>
                  </div>
                  <div className="canvas-head-actions">
                  <button className="icon-text-btn" onClick={() => void refreshTopology()} title="重新读取显示器信息">
                    <IconRefresh size={14} />刷新显示器
                  </button>
                    <button className="icon-text-btn layout-toggle" aria-expanded={layoutMode !== "hidden"} onClick={() => setLayoutMode(layoutMode === "hidden" ? "expanded" : "hidden")}>
                      <IconChevron size={12} className={layoutMode === "hidden" ? "" : "is-open"} />{layoutMode === "hidden" ? "展开布局" : "收起布局"}
                    </button>
                  </div>
                </div>
                <div className={`display-studio${layoutMode === "hidden" ? " is-collapsed" : ""}`}>
                  <div className="display-studio-topology">
                    <TopologyCanvas collapsed={layoutMode === "hidden"}
                      topology={visibleTopology} wallpaperMap={screenWallpapers} selected={selected}
                      pendingWallpaper={activeWallpaper} position={position}
                      onToggleSelect={toggleSelect} drag={wallpaperDrag.state}
                      externalTargetId={externalDrop?.phase === "hover" ? externalDrop.targetId : null}
                      onPickFor={(identity) => setSelected(new Set([identity]))} />
                  </div>
                  <DisplayApplyPanel {...displayPanelProps} compact={layoutMode === "hidden"} />
                </div>
              </div>

              <WallpaperGrid
                wallpapers={wallpapers}
                activeIds={activeIds}
                screenLabels={screenLabels}
                selectedId={activeId}
                draggingId={draggingId}
                onPointerDrag={wallpaperDrag.start}
                onSelect={handleSelectWallpaper}
                onPreview={openPreview}
                onDetails={openDetails}
                onRelink={(wallpaper) => void handleRelink(wallpaper)}
                onDelete={(w) => setDialog({ kind: "delete-wallpaper", wallpaper: w })}
                onMove={(w) => setDialog({ kind: "move", wallpaper: w })}
                onRefresh={() => void handleRefreshIndex()}
                onImport={() => void handleImport()}
                onImportFolder={openFolderImport}
                importing={importing}
                scopeTitle="选择壁纸"
                scopeHint=""
                importLabel="添加图片"
              />
            </div>
          )}

          {view === "library" && (
            <div className="library-page">
              <WallpaperGrid
                wallpapers={scopedWallpapers}
                activeIds={activeIds}
                screenLabels={screenLabels}
                selectedId={activeId}
                draggingId={draggingId}
                onPointerDrag={wallpaperDrag.start}
                onSelect={handleSelectWallpaper}
                onPreview={openPreview}
                onDetails={openDetails}
                onRelink={(wallpaper) => void handleRelink(wallpaper)}
                onDelete={(w) => setDialog({ kind: "delete-wallpaper", wallpaper: w })}
                onMove={(w) => setDialog({ kind: "move", wallpaper: w })}
                onRefresh={() => void handleRefreshIndex()}
                onImport={() => void handleImport()}
                onImportFolder={openFolderImport}
                importing={importing}
                filters={<div className="gallery-filters" aria-label="壁纸分类">
                  <button className={scope.kind === "all" ? "is-current" : ""} aria-pressed={scope.kind === "all"} onClick={() => setScope({ kind: "all" })}>全部壁纸 <span>{wallpapers.length}</span></button>
                  <button className={scope.kind === "unfiled" ? "is-current" : ""} aria-pressed={scope.kind === "unfiled"} onClick={() => setScope({ kind: "unfiled" })}>未归类 <span>{wallpapers.filter(w => !w.folderId).length}</span></button>
                  {folders.filter(folder => !folder.parentId || (scope.kind === "folder" && folder.id === scope.id)).map(folder => (
                    <button key={folder.id} className={scope.kind === "folder" && scope.id === folder.id ? "is-current" : ""} aria-pressed={scope.kind === "folder" && scope.id === folder.id} onClick={() => setScope({ kind: "folder", id: folder.id, recursive: true })}>{folder.name} <span>{folder.totalCount}</span></button>
                  ))}

                </div>}
                scopeTitle={scopeTitle}
                scopeHint={scopeHint}
                importLabel={importLabel}
              />
            </div>
          )}

          {view === "collections" && (
            <CollectionsView
              folders={folders}
              onOpen={(id) => {
                setScope({ kind: "folder", id, recursive: true });
                setView("library");
              }}
              onCreate={(parentId) => setDialog({ kind: "new-folder", parentId })}
              onRename={(f) => setDialog({ kind: "rename-folder", id: f.id, name: f.name })}
              onDelete={(f) =>
                setDialog({
                  kind: "delete-folder",
                  id: f.id,
                  name: f.name,
                  total: f.totalCount,
                })
              }
            />
          )}

          {view === "sources" && (
            <SourcesView
              onImport={importOnline}
              targetLabel={selected.size ? `已选 ${selected.size} 块显示器` : "全部显示器"}
              onSelectTargets={() => setView("display")}
              onOpenExternal={(url) => {
                void openUrl(url).catch((e) =>
                  notify(`无法打开链接：${(e as Error).message ?? e}`, "error"),
                );
              }}
            />
          )}

          {view === "settings" && (
            <SettingsView
              totalCount={wallpapers.length}
              monitorCount={monitors.length}
              virtualCount={virtualCount}
              showVirtual={showVirtual}
              onShowVirtualChange={changeShowVirtual}
              onRefreshMonitors={refreshTopology}
              onOpenLibrary={() => { setScope({ kind: "all" }); setView("library"); }}
              onNotify={notify}
            />
          )}
          </m.div>
          </AnimatePresence>
          {activeWallpaper && view === "library" && <WallpaperApplyBar
          monitors={monitors}
          selected={selected}
          wallpaperMap={screenWallpapers}
          pendingWallpaper={activeWallpaper}
          onPreview={openPreview}
          onRelink={(wallpaper) => void handleRelink(wallpaper)}
          position={position}
          onPositionChange={setPosition}
          fitMessage={fitMessage}
          onApplyAll={applyAll}
          onApplySelected={applySelected}
          onApplySpan={applySpan}
          busy={busy}
          onClearSelection={() => setSelected(new Set())}
          onToggleSelect={toggleSelect}
          onRefresh={() => void refreshTopology()}
          />}
        </main>
      </div>

      {/* ---------------- 弹窗 ---------------- */}

      {dialog.kind === "new-folder" && (
        <PromptDialog
          title={dialog.parentId ? "新建子合集" : "新建合集"}
          placeholder="合集名称，如「工作」「风景」"
          confirmText="创建"
          onCancel={() => setDialog({ kind: "none" })}
          onSubmit={(name) => submitNewFolder(name, dialog.parentId)}
        />
      )}

      {dialog.kind === "rename-folder" && (
        <PromptDialog
          title="重命名合集"
          defaultValue={dialog.name}
          confirmText="保存"
          onCancel={() => setDialog({ kind: "none" })}
          onSubmit={(name) => submitRenameFolder(dialog.id, name)}
        />
      )}

      {dialog.kind === "delete-folder" && (
        <ConfirmDialog
          title={`删除合集「${dialog.name}」？`}
          body={
            dialog.total > 0
              ? `合集内的 ${dialog.total} 张壁纸不会被删除，会移动到上一级；子合集同样上移一级。`
              : "这是一个空合集，删除后不影响任何壁纸。"
          }
          confirmText="删除合集"
          danger
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => void submitDeleteFolder(dialog.id)}
        />
      )}

      {dialog.kind === "move" && (
        <MoveDialog
          wallpaperName={dialog.wallpaper.name}
          folders={folders}
          currentFolderId={dialog.wallpaper.folderId}
          onCancel={() => setDialog({ kind: "none" })}
          onPick={(folderId) => void submitMove(dialog.wallpaper, folderId)}
          onCreateFolder={(parentId) => setDialog({ kind: "new-folder", parentId })}
        />
      )}

      {dialog.kind === "delete-wallpaper" && (
        <ConfirmDialog
          title={`从库中移除「${dialog.wallpaper.name}」？`}
          body={dialog.wallpaper.storageKind === "indexed" ? "只移除索引和缩略图，不删除原文件；来源文件夹重新扫描时也不会自动加回。当前桌面使用的投放缓存会保留。" : "只移除应用保存的图片和缩略图，不影响来源文件；当前桌面的投放缓存会保留。"}
          confirmText="移除"
          danger
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => void submitDeleteWallpaper(dialog.wallpaper)}
        />
      )}

      {dialog.kind === "import-folder" && (
        <FolderImportDialog
          title="添加本机文件夹"
          description="关联本机文件夹，图片只建立索引，不复制或修改原文件。应用启动或手动刷新时会扫描新增和变化；合集仅用于分类。"
          folders={folders}
          path={pickPath}
          scan={pickScan}
          scanning={pickScanning}
          busy={importing}
          targetFolderId={pickTarget}
          onTargetFolderChange={setPickTarget}
          onPickPath={() => void chooseFolder()}
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => void runFolderImport()}
          error={pickError}
        />
      )}

      <AnimatePresence>
      {previewWallpaper && <WallpaperPreview
        wallpaper={previewWallpaper}
        items={previewItems}
        onNavigate={navigatePreview}
        onClose={closePreview}
        onDetails={openDetails}
        controls={<WallpaperApplyBar compact
          monitors={monitors}
          selected={selected}
          wallpaperMap={screenWallpapers}
          pendingWallpaper={activeWallpaper}
          onPreview={openPreview}
          onRelink={(wallpaper) => void handleRelink(wallpaper)}
          position={position}
          onPositionChange={setPosition}
          fitMessage={fitMessage}
          onApplyAll={applyAll}
          onApplySelected={applySelected}
          onApplySpan={applySpan}
          busy={busy}
          onClearSelection={() => setSelected(new Set())}
          onToggleSelect={toggleSelect}
          onRefresh={() => void refreshTopology()}
          />}
      />}
      </AnimatePresence>
      <AnimatePresence onExitComplete={() => requestAnimationFrame(() => detailsReturnFocus.current?.focus({ preventScroll: true }))}>
        {detailsWallpaper && <WallpaperDetails wallpaper={detailsWallpaper} onClose={closeDetails}
          onRelink={(wallpaper) => { closeDetails(); void handleRelink(wallpaper); }} />}
      </AnimatePresence>
      <WallpaperDragLayer drag={wallpaperDrag.state} x={wallpaperDrag.x} y={wallpaperDrag.y}
        monitors={monitors} wallpaperMap={screenWallpapers} showShelf={view !== "display"} selectedCount={selected.size} />
      <ExternalFileDropLayer state={externalDrop} monitors={monitors} wallpaperMap={screenWallpapers}
        showShelf={view !== "display"} />
      <Toast items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div></MotionConfig></LazyMotion>
  );
}

/** 收集某个合集自身及所有后代的 id，用于前端穿透过滤。 */
function collectSubtree(folders: FolderNode[], rootId: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const arr = byParent.get(f.parentId) ?? [];
    arr.push(f.id);
    byParent.set(f.parentId, arr);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  // 深度上限防止脏数据成环
  for (let guard = 0; stack.length > 0 && guard < 64; guard++) {
    const cur = stack.pop() as string;
    for (const child of byParent.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}
