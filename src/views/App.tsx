import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import type {
  FolderNode,
  FolderScan,
  LibraryScope,
  Monitor,
  Position,
  Topology,
  Wallpaper,
} from "../lib/types";
import { TopologyCanvas } from "../components/TopologyCanvas";
import { WallpaperGrid } from "../components/WallpaperGrid";
import { MonitorPanel } from "../components/MonitorPanel";
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
import { IconRefresh } from "../components/icons";
import { useScreenWallpapers } from "../hooks/useScreenWallpapers";

/**
 * 主视图：左侧导航 + 中间内容区 + 右侧属性面板。
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

export default function App() {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([]);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [view, setView] = useState<NavView>("display");
  const [scope, setScope] = useState<LibraryScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [position, setPosition] = useState<Position>("fill");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fitMessage, setFitMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [showVirtual, setShowVirtual] = useState(false);
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
    try {
      setTopology(await api.listMonitors());
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  /** 全量刷新：壁纸、合集树、当前范围的内容一次拉齐，保证三者一致。 */
  const refreshAll = useCallback(async () => {
    try {
      const [list, tree] = await Promise.all([api.libraryList(), api.folderTree()]);
      setWallpapers(list);
      setFolders(tree);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  useEffect(() => {
    void refreshTopology();
    void refreshAll();
  }, [refreshTopology, refreshAll]);

  // 后端写操作后广播，这里跟随刷新
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("library://changed", () => void refreshAll());
    })();
    return () => unlisten?.();
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

  /**
   * 每块屏当前实际展示的壁纸。
   *
   * 系统壁纸未必来自本库（用户可能用系统设置换过图），
   * 因此由 hook 同时处理「库里命中」与「库外解码预览」两条路径。
   */
  const screenWallpapers = useScreenWallpapers(monitors, wallpapers);

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

  /** 正在被某块屏使用的库内壁纸 id，用于在卡片上打「使用中」角标。 */
  const activeIds = useMemo(() => {
    const s = new Set<string>();
    for (const w of screenWallpapers.values()) {
      if (w.kind === "library") s.add(w.wallpaper.id);
    }
    return s;
  }, [screenWallpapers]);

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
    // 面板主按钮：有选中屏时作用于选中屏，否则作用于全部
    if (selected.size > 0) {
      const ids = Array.from(selected);
      void runApply(
        () => api.applyWallpaper(activeId, { type: "identities", value: ids }, position),
        `已应用到 ${ids.length} 块屏幕`,
      );
      return;
    }
    void runApply(
      () =>
        api.applyWallpaper(
          activeId,
          { type: "all", value: { includeVirtual: showVirtual } },
          position,
        ),
      "已应用到所有屏幕",
    );
  }, [activeId, position, runApply, selected, showVirtual]);

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
      const wp = wallpapers.find((w) => w.id === wpId);
      if (applyAllFlag) {
        void runApply(
          () =>
            api.applyWallpaper(
              wpId,
              { type: "all", value: { includeVirtual: showVirtual } },
              position,
            ),
          "已应用到所有屏幕",
        );
        return;
      }
      void runApply(
        () => api.applyWallpaper(wpId, { type: "identities", value: identities }, position),
        wp ? `已将「${wp.name}」应用到 ${identities.length} 块屏` : "已应用",
      );
    },
    [position, runApply, showVirtual, wallpapers],
  );

  /** 点击壁纸：先选中，再按当前选择范围应用。 */
  const handleApplyWallpaper = useCallback(
    (w: Wallpaper) => {
      setActiveId(w.id);
      if (selected.size === 0) {
        void runApply(
          () =>
            api.applyWallpaper(
              w.id,
              { type: "all", value: { includeVirtual: showVirtual } },
              position,
            ),
          `已将「${w.name}」应用到所有屏幕`,
        );
      } else {
        void runApply(
          () =>
            api.applyWallpaper(w.id, { type: "identities", value: Array.from(selected) }, position),
          `已将「${w.name}」应用到 ${selected.size} 块屏幕`,
        );
      }
    },
    [position, runApply, selected, showVirtual],
  );

  /** 导入：会把图片归入当前浏览的合集。根目录范围导入到根。 */
  const handleImport = useCallback(async () => {
    const targetFolder =
      scope.kind === "folder" ? scope.id : null;

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
  }, [notify, refreshAll, scope]);

  // ---------------- 添加本机文件夹 ----------------

  /** 打开「添加本机文件夹」弹窗，默认归入当前浏览的合集。 */
  const openFolderImport = useCallback(() => {
    setPickPath("");
    setPickScan(null);
    setPickError(null);
    setPickTarget(scope.kind === "folder" ? scope.id : null);
    setDialog({ kind: "import-folder" });
  }, [scope]);

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
      setDialog({ kind: "none" });
      try {
        const created = await api.folderCreate(name, parentId);
        await refreshAll();
        // 建完直接切到新合集，符合「建了就是要往里放东西」的预期
        setScope({ kind: "folder", id: created.id, recursive: true });
        setView("library");
        notify(`已新建合集「${name}」`, "success");
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [notify, refreshAll],
  );

  const submitRenameFolder = useCallback(
    async (id: string, name: string) => {
      setDialog({ kind: "none" });
      try {
        await api.folderRename(id, name);
        await refreshAll();
      } catch (e) {
        notify((e as Error).message, "error");
      }
    },
    [notify, refreshAll],
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

  const importLabel = scope.kind === "folder" ? "导入到此合集" : "导入图片";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          桌面壁纸
        </div>
        <div className="topbar-actions">
          <button
            className="icon-text-btn"
            onClick={() => void refreshTopology()}
            title="重新读取显示器信息"
          >
            <IconRefresh size={14} />
            刷新显示器
          </button>
        </div>
      </header>

      <div className="shell">
        <SideNav
          view={view}
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
          {view === "display" && (
            <div className="display-page">
              <div className="canvas-wrap">
                <div className="canvas-head">
                  <div className="canvas-head-main">
                    <h1>显示器布局</h1>
                    <span className="canvas-head-sub">
                      按系统实际排列绘制 · 拖拽壁纸到屏幕上可直接设置
                    </span>
                  </div>
                  {selected.size > 0 && (
                    <div className="selection-chip">
                      已选 {selected.size} 块屏
                      <button className="link-btn" onClick={() => setSelected(new Set())}>
                        清除
                      </button>
                    </div>
                  )}
                </div>
                <TopologyCanvas
                  topology={topology ? { ...topology, monitors } : null}
                  wallpaperMap={screenWallpapers}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onDropWallpaper={handleDropWallpaper}
                  draggingId={draggingId}
                  onPickFor={(identity) => {
                    setSelected(new Set([identity]));
                    setView("library");
                  }}
                />
              </div>

              <WallpaperGrid
                wallpapers={scopedWallpapers}
                activeIds={activeIds}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onApply={handleApplyWallpaper}
                onDelete={(w) => setDialog({ kind: "delete-wallpaper", wallpaper: w })}
                onMove={(w) => setDialog({ kind: "move", wallpaper: w })}
                onImport={() => void handleImport()}
                onImportFolder={openFolderImport}
                importing={importing}
                scopeTitle={scopeTitle}
                scopeHint={scopeHint}
                importLabel={importLabel}
              />
            </div>
          )}

          {view === "library" && (
            <div className="library-page">
              <WallpaperGrid
                wallpapers={scopedWallpapers}
                activeIds={activeIds}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onApply={handleApplyWallpaper}
                onDelete={(w) => setDialog({ kind: "delete-wallpaper", wallpaper: w })}
                onMove={(w) => setDialog({ kind: "move", wallpaper: w })}
                onImport={() => void handleImport()}
                onImportFolder={openFolderImport}
                importing={importing}
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
              onShowVirtualChange={setShowVirtual}
              onNotify={notify}
            />
          )}
        </main>

        <MonitorPanel
          monitors={monitors}
          selected={selected}
          wallpaperMap={screenWallpapers}
          pendingWallpaper={activeWallpaper}
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
        />
      </div>

      {/* ---------------- 弹窗 ---------------- */}

      {dialog.kind === "new-folder" && (
        <PromptDialog
          title={dialog.parentId ? "新建子合集" : "新建合集"}
          placeholder="合集名称，如「工作」「风景」"
          confirmText="创建"
          onCancel={() => setDialog({ kind: "none" })}
          onSubmit={(name) => void submitNewFolder(name, dialog.parentId)}
        />
      )}

      {dialog.kind === "rename-folder" && (
        <PromptDialog
          title="重命名合集"
          defaultValue={dialog.name}
          confirmText="保存"
          onCancel={() => setDialog({ kind: "none" })}
          onSubmit={(name) => void submitRenameFolder(dialog.id, name)}
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
          body="只会删除应用内的副本，你电脑上的原始图片不受影响。"
          confirmText="移除"
          danger
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => void submitDeleteWallpaper(dialog.wallpaper)}
        />
      )}

      {dialog.kind === "import-folder" && (
        <FolderImportDialog
          title="添加本机文件夹"
          description="选择一个本机文件夹，其中的图片（含子文件夹）会被扫描并复制进壁纸库。原始文件不会被修改或删除。"
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

      <Toast items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
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
