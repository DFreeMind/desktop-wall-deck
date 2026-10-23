import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { formatBytes } from "../components/WallpaperGrid";
import { ConfirmDialog } from "../components/dialogs";
import { IconFolder, IconImage, IconLibrary, IconMonitor, IconRefresh } from "../components/icons";
import "./SettingsView.css";
import { applyTheme, cancelThemePreview, previewTheme, THEME_COLORS, useTheme } from "../lib/theme";
import type { Decoration } from "../lib/theme";
import { m, useReducedMotion } from "motion/react";

interface Props {
  totalCount: number;
  monitorCount: number;
  virtualCount: number;
  showVirtual: boolean;
  onShowVirtualChange: (v: boolean) => void;
  onRefreshMonitors: () => Promise<void>;
  onOpenLibrary: () => void;
  onNotify: (msg: string, kind?: "info" | "success" | "warn" | "error") => void;
}

interface SourceFolder {
  id: string;
  path: string;
  folderId: string | null;
  available: boolean;
}

interface LibraryStorage {
  indexedBytes: number;
  managedBytes: number;
  thumbnailBytes: number;
  renderedBytes: number;
  count: number;
}

/** 设置页。只放真正需要用户决定的选项，不做「关于」之类的填充内容。 */
export function SettingsView({
  totalCount,
  monitorCount,
  virtualCount,
  showVirtual,
  onShowVirtualChange,
  onRefreshMonitors,
  onOpenLibrary,
  onNotify,
}: Props) {
  const reducedMotion = useReducedMotion();
  const [category, setCategory] = useState<"appearance" | "display" | "sources" | "storage">("appearance");
  const pageRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const categories = [
    { id: "appearance", label: "外观", icon: IconImage },
    { id: "display", label: "显示器", icon: IconMonitor },
    { id: "sources", label: "图片来源", icon: IconFolder },
    { id: "storage", label: "存储与缓存", icon: IconLibrary },
  ] as const;
  const selectCategory = (id: typeof category) => {
    if (category === "appearance" && id !== category) cancelThemePreview();
    setCategory(id);
    if (id !== category) pageRef.current?.closest(".workspace-page-settings")?.scrollTo({ top: 0, behavior: "instant" });
  };
  const { applied, draft } = useTheme();
  const themeChanged = draft.color !== applied.color || draft.decoration !== applied.decoration;
  useEffect(() => () => cancelThemePreview(), []);
  const [dir, setDir] = useState("");
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [usage, setUsage] = useState<LibraryStorage | null>(null);
  const [sources, setSources] = useState<SourceFolder[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<SourceFolder | null>(null);
  const [storageBusy, setStorageBusy] = useState<"repair" | "cleanup" | "open" | null>(null);
  const storageLock = useRef(false);
  const [cleanupConfirm, setCleanupConfirm] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [monitorRefreshing, setMonitorRefreshing] = useState(false);

  const refreshSources = useCallback(async () => {
    setSourcesError(null);
    setSourcesLoading(true);
    try {
      setSources(await api.sourceFolders());
    } catch (e) {
      setSourcesError((e as Error).message || "读取本机来源失败");
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    setStorageLoading(true);
    setStorageError(null);
    const [directory, storage] = await Promise.allSettled([api.dataDir(), api.libraryStorage()]);
    if (directory.status === "fulfilled") setDir(directory.value);
    if (storage.status === "fulfilled") setUsage(storage.value);
    if (directory.status === "rejected" || storage.status === "rejected") setStorageError("部分存储信息未能读取，请重试。");
    setStorageLoading(false);
  }, []);

  useEffect(() => {
    void refreshStorage();
    void refreshSources();
  }, [refreshStorage, refreshSources]);

  const maintainStorage = async (operation: "repair" | "cleanup" | "open") => {
    if (storageLock.current) return;
    storageLock.current = true;
    setStorageBusy(operation); setMaintenanceError(null); setMaintenanceMessage(null);
    try {
      if (operation === "repair") {
        const count = await api.libraryRepairThumbnails();
        setMaintenanceMessage(count > 0 ? `已补齐 ${count} 张缩略图，壁纸列表已同步更新。` : "未生成新的缩略图。若仍有空白图片，请检查原文件是否可访问。");
      } else if (operation === "cleanup") {
        const report = await api.cleanupLibraryCaches();
        setMaintenanceMessage(report.removedFiles > 0 ? `已清理 ${report.removedFiles} 个闲置文件，释放 ${formatBytes(report.freedBytes)}。` : "没有符合条件的闲置缓存，在用、关联与近期文件均已保留。");
        if (report.failedFiles > 0) setMaintenanceError(`${report.failedFiles} 个文件未能清理，可稍后重试。`);
      } else await api.openDataDir();
      if (operation !== "open") await refreshStorage();
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setMaintenanceError(message); onNotify(message, "error"); }
    finally { storageLock.current = false; setStorageBusy(null); }
  };

  const showReport = (report: Awaited<ReturnType<typeof api.sourceRescan>>) => {
    const parts = [`新增 ${report.added} 张`];
    if (report.updated) parts.push(`更新 ${report.updated} 张`);
    if (report.skipped > 0) parts.push(`跳过 ${report.skipped} 张`);
    if (report.failed.length > 0) parts.push(`失败 ${report.failed.length} 张`);
    onNotify(parts.join("，"), report.failed.length > 0 ? "warn" : "success");
    if (report.failed.length > 0) onNotify(report.failed[0].reason, "error");
  };

  const rescanSource = async (source: SourceFolder) => {
    setBusySourceId(source.id);
    setSourcesError(null);
    try {
      showReport(await api.sourceRescan(source.id));
      await refreshSources();
      await refreshStorage();
    } catch (e) {
      setSourcesError((e as Error).message || "重新扫描失败");
    } finally {
      setBusySourceId(null);
    }
  };

  const relocateSource = async (source: SourceFolder) => {
    setSourcesError(null);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      setBusySourceId(source.id);
      showReport(await api.sourceRelocate(source.id, picked));
      await refreshSources();
      await refreshStorage();
    } catch (e) {
      setSourcesError((e as Error).message || "重新定位来源失败");
    } finally {
      setBusySourceId(null);
    }
  };

  const removeSource = async () => {
    if (!pendingRemove) return;
    const source = pendingRemove;
    setBusySourceId(source.id);
    setSourcesError(null);
    try {
      await api.sourceRemove(source.id);
      setPendingRemove(null);
      onNotify("已取消本机来源关联", "success");
      await refreshSources();
    } catch (e) {
      setSourcesError((e as Error).message || "取消来源关联失败");
    } finally {
      setBusySourceId(null);
    }
  };

  const cachedBytes = usage
    ? usage.managedBytes + usage.thumbnailBytes + usage.renderedBytes
    : null;

  const storageValue = (value: number | undefined) => value === undefined ? (storageLoading ? "读取中…" : "—") : formatBytes(value);
  const cacheParts = [
    { label: "缩略图", bytes: usage?.thumbnailBytes, note: "补齐缺失或空白的缩略图，保持列表正常显示" },
    { label: "投放缓存", bytes: usage?.renderedBytes, note: "投放与系统预览缓存，可安全回收已过期的闲置文件" },
    { label: "下载与旧版副本", bytes: usage?.managedBytes, note: "在线下载和旧版副本，请在壁纸库中按图片管理" },
  ];

  return (
    <div ref={pageRef} className="page settings-view">
      <header className="settings-heading">
        <div><h1>设置</h1><p>让工作台更合你的习惯</p></div>
        <span className="settings-heading-note">为你的桌面而设</span>
      </header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {categories.map((item, index) => <button key={item.id} ref={node => { tabRefs.current[index] = node; }} id={`settings-tab-${item.id}`} role="tab" aria-selected={category === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={category === item.id ? 0 : -1} onClick={() => selectCategory(item.id)} onKeyDown={event => {
          const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!offset && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : (index + offset + categories.length) % categories.length;
          selectCategory(categories[next].id); tabRefs.current[next]?.focus();
        }}><item.icon size={16} />{item.label}</button>)}
      </div>

      <m.div key={category} role="tabpanel" id={`settings-panel-${category}`} aria-labelledby={`settings-tab-${category}`} tabIndex={0} className="settings-panel" initial={{ opacity: reducedMotion ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ duration: reducedMotion ? 0 : .14 }}>
      {category === "appearance" && <>
        <div className="settings-section-heading"><h2>为工作台选一种气质</h2><p>主题色与背景点缀会即时预览，满意后再应用。</p></div>
        <section className="settings-appearance setting-group" aria-label="外观设置">
          <div className="settings-appearance-controls">
            <div className="settings-field-heading"><h3>主题色</h3><span>侧栏与界面强调色</span></div>
            <div className="theme-palette" aria-label="主题色">
              {THEME_COLORS.map(item => <button key={item.color} className="theme-swatch" aria-pressed={draft.color === item.color} onClick={() => previewTheme({ ...draft, color: item.color })}><i style={{ "--swatch": item.color } as React.CSSProperties} />{item.name}</button>)}
              <label className="theme-custom">自定义<input type="color" value={draft.color} aria-label="自定义主题色" onChange={event => previewTheme({ ...draft, color: event.target.value })} /></label>
            </div>
            <p className="theme-color-note">浅色会适当加深，让按钮文字保持清晰。</p>
            <div className="settings-field-heading settings-decoration-heading"><h3>背景点缀</h3><span>轻一点，让壁纸更出彩</span></div>
            <div className="theme-decoration-options" aria-label="背景点缀">
              {([{ id: "plain", label: "纯净" }, { id: "glow", label: "柔和光晕" }, { id: "grid", label: "细网格" }] as { id: Decoration; label: string }[]).map(item => <button key={item.id} className={`theme-decoration is-${item.id}`} aria-pressed={draft.decoration === item.id} onClick={() => previewTheme({ ...draft, decoration: item.id })}><span aria-hidden="true" />{item.label}</button>)}
            </div>
          </div>
          <aside className="settings-live-preview" aria-label="主题效果预览">
            <div className="settings-preview-caption"><span className="settings-live-dot" />实时预览<span>{themeChanged ? "预览中" : "已应用"}</span></div>
            <div className={`theme-scene is-${draft.decoration}`} aria-hidden="true">
              <div className="theme-scene-sidebar"><IconImage size={20} /><i /><i className="active" /><i /><div /><i /></div>
              <div className="theme-scene-main"><div className="theme-scene-toolbar"><b /><i /></div><div className="theme-scene-cards">{Array.from({ length: 6 }, (_, i) => <span key={i} />)}</div><div className="theme-scene-bottom"><i /><b /></div></div>
            </div>
            <strong>{THEME_COLORS.find(item => item.color === draft.color)?.name ?? "自定义主题"}</strong>
            <p>深色侧栏 · 浅色图库<br />颜色与背景同步变化</p>
          </aside>
          <div className="theme-footer"><span role="status">{themeChanged ? "尚未应用，离开此分类将恢复原主题" : "当前外观已应用"}</span><button onClick={cancelThemePreview} disabled={!themeChanged}>取消</button><button className="primary" disabled={!themeChanged} onClick={() => { try { applyTheme(); onNotify("主题已应用", "success"); } catch { onNotify("无法保存主题设置，请重试", "error"); } }}>应用</button></div>
        </section>
      </>}

      {category === "display" && <>
        <div className="settings-section-heading"><h2>显示器与投放</h2><p>控制布局中显示哪些屏幕。这些选项修改后立即生效。</p></div>
        <section className="setting-group settings-display-card" aria-label="显示器设置">
          <div className="settings-summary"><span className="settings-summary-icon"><IconMonitor size={24} /></span><div><strong>{monitorCount} 块可见显示器</strong><p>热插拔后按显示器身份自动恢复壁纸。</p></div><button className="ghost settings-monitor-refresh" disabled={monitorRefreshing} onClick={() => { setMonitorRefreshing(true); void onRefreshMonitors().finally(() => setMonitorRefreshing(false)); }}><IconRefresh size={14} />{monitorRefreshing ? "读取中…" : "重新检测"}</button></div>
          <div className="setting-row"><div className="setting-label"><span>在布局中显示虚拟屏幕</span><p>{virtualCount > 0 ? `检测到 ${virtualCount} 块虚拟显示器，可能来自模拟器、串流或远程桌面。` : "当前未检测到虚拟屏幕，也可以提前开启，检测到后自动显示。"}</p></div>
            <label className="switch"><input type="checkbox" aria-label="在布局中显示虚拟屏幕" checked={showVirtual} onChange={event => onShowVirtualChange(event.target.checked)} /><span className="switch-track"><span className="switch-thumb" /></span></label>
          </div>
        </section>
        <p className="settings-footnote">{showVirtual ? "已开启：检测到的虚拟屏幕会出现在显示器布局中，此偏好会保留。" : "已关闭：布局仅显示物理屏幕。开启后即可显示已检测到的虚拟屏幕。"}</p>
      </>}

      {category === "sources" && <>
        <div className="settings-section-heading"><h2>本机图片来源</h2><p>管理已登记的文件夹，找回移动后的图片。</p></div>
        <section className="setting-group source-settings" aria-label="本机来源设置">
          <div className="settings-source-heading"><div><h3>来源文件夹</h3><p>在壁纸库中使用“添加文件夹”登记来源，启动或手动刷新时扫描变化。</p></div><span>{sources.length} 个来源</span></div>
          {sourcesError && <div className="settings-error" role="alert"><span>{sourcesError}</span><button onClick={() => void refreshSources()}>重试</button></div>}
          {sourcesLoading && sources.length === 0 ? <p className="settings-empty" role="status">正在读取本机来源…</p> : sources.length === 0 ? <div className="settings-empty"><IconFolder size={28} /><strong>还没有来源文件夹</strong><p>回到壁纸库，使用“添加文件夹”扫描并确认索引。</p></div> : <div className="source-list">{sources.map(source => {
            const busy = busySourceId === source.id;
            return <div className="source-item" key={source.id}><span className="settings-source-icon"><IconFolder size={20} /></span><div className="source-item-info"><div className="source-item-status"><strong>{source.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source.path}</strong><span className={`source-state ${source.available ? "is-online" : "is-offline"}`}>{source.available ? "可访问" : "不可访问"}</span></div><p className="mono-path source-path">{source.path}</p></div><div className="source-item-actions"><button disabled={busySourceId !== null} onClick={() => void rescanSource(source)}>{busy ? "处理中…" : "重新扫描"}</button><button disabled={busySourceId !== null} onClick={() => void relocateSource(source)}>重新定位</button><button className="ghost source-remove" disabled={busySourceId !== null} onClick={() => setPendingRemove(source)}>取消关联</button></div></div>;
          })}</div>}
        </section>
        <div className="settings-info-note"><IconFolder size={17} /><p>重新定位按相对路径找回图片，保留名称和合集。取消关联只移除来源记录，不删除原图或已有索引。</p></div>
      </>}

      {category === "storage" && <>
        <div className="settings-section-heading"><h2>存储与缓存</h2><p>原图保留在原位置。这里可以修复缩略图、回收闲置缓存，或管理图片。</p></div>
        {storageError && <div className="settings-error" role="alert"><span>{storageError}</span><button disabled={storageLoading} onClick={() => void refreshStorage()}>重试</button></div>}
        <div className="settings-storage-overview">
          <section className="setting-group"><span>原文件索引</span><strong>{usage ? usage.count : totalCount}<small>张壁纸</small></strong><p>{storageValue(usage?.indexedBytes)} · 原文件不占应用空间</p><button className="ghost" disabled={storageBusy !== null} onClick={onOpenLibrary}>管理图片 →</button></section>
          <section className="setting-group"><span>应用缓存</span><strong>{cachedBytes === null ? (storageLoading ? "读取中…" : "—") : formatBytes(cachedBytes)}</strong><p>缩略图、投放缓存与下载副本</p><span className="settings-storage-help">在用文件与原图始终保留</span></section>
        </div>
        <section className="setting-group settings-cache-card" aria-label="缓存管理">
          <div className="settings-storage-toolbar"><div><h3>缓存管理</h3><p>只处理应用派生缓存，不改动本机原图。</p></div><button className="ghost" disabled={storageLoading || storageBusy !== null} onClick={() => void refreshStorage()}><IconRefresh size={14} />{storageLoading ? "统计中…" : "刷新统计"}</button></div>
          {cacheParts.map((item, index) => <div className="setting-row" key={item.label}><div className="setting-label"><span>{item.label}</span><p>{item.note}</p></div><div className="settings-cache-action"><span className="setting-value">{storageValue(item.bytes)}</span>{index === 0 ? <button disabled={storageBusy !== null} onClick={() => void maintainStorage("repair")}>{storageBusy === "repair" ? "修复中…" : "修复缩略图"}</button> : index === 1 ? <button disabled={storageBusy !== null} onClick={() => setCleanupConfirm(true)}>{storageBusy === "cleanup" ? "清理中…" : "清理闲置缓存"}</button> : <button className="ghost" disabled={storageBusy !== null} onClick={onOpenLibrary}>到壁纸库管理</button>}</div></div>)}
          <p className="settings-storage-help">清理范围：超过 24 小时、未被库记录或屏幕引用的派生缓存，以及过期系统预览。在用壁纸、下载原图和跨屏分片均不删除。</p>
          {maintenanceMessage && <p className="settings-maintenance-result" role="status">{maintenanceMessage}</p>}
          {maintenanceError && <p className="settings-maintenance-error" role="alert">{maintenanceError}</p>}
        </section>
        <section className="setting-group settings-path-card"><div className="settings-source-heading"><div><h3>数据与缓存位置</h3><p>应用管理的数据目录，与本机原图来源相互独立。</p></div><div className="settings-cache-actions"><button disabled={storageBusy !== null} onClick={() => void maintainStorage("open")}>{storageBusy === "open" ? "正在打开…" : "打开文件夹"}</button><button disabled={!dir} onClick={() => { void navigator.clipboard.writeText(dir).then(() => onNotify("路径已复制", "success")).catch(() => onNotify("复制失败，请手动选择文本", "error")); }}>复制路径</button></div></div><p className="mono-path">{dir || (storageLoading ? "读取中…" : "路径暂时无法读取")}</p></section>
      </>}
      </m.div>
      {cleanupConfirm && <ConfirmDialog title="清理闲置缓存？" body="仅回收超过 24 小时、未被图片记录或屏幕引用的派生缓存，以及过期系统预览。原图、下载图片、在用文件与跨屏分片都会保留。清理不会修改你的桌面壁纸。" confirmText="清理闲置缓存" onCancel={() => setCleanupConfirm(false)} onConfirm={() => { setCleanupConfirm(false); void maintainStorage("cleanup"); }} />}
      {pendingRemove && <ConfirmDialog title="取消本机来源关联？" body={`将不再跟踪“${pendingRemove.path}”。这只会取消来源记录，已有图片索引和原文件都会保留，不会删除任何文件。`} confirmText="取消关联" danger onCancel={() => setPendingRemove(null)} onConfirm={() => void removeSource()} />}
    </div>
  );
}
