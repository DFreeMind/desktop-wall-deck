/**
 * 后端命令封装。
 *
 * 所有 invoke 集中在此，组件不直接触碰命令名，改名时只需改一处。
 * 统一把后端返回的错误字符串抛成 Error，便于上层用 try/catch 处理。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  OnlineSearchResult,
  OnlineImportResult,
  Folder,
  FolderNode,
  FolderScan,
  ImportReport,
  Position,
  Target,
  Topology,
  Wallpaper,
  WallpaperDetails,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const result = await invoke<T>(cmd, args);
    if (libraryWrites.has(cmd)) invalidateLibraryReads();
    if (cmd === "apply_wallpaper" || cmd === "apply_span") pendingReads.delete("list_monitors");
    return result;
  } catch (e) {
    // 后端统一返回 String，这里原样抛出保留中文提示
    throw new Error(typeof e === "string" ? e : String(e));
  }
}

// 只合并仍在进行的只读请求；不保留完成后的值，手动刷新始终读取最新数据。
const pendingReads = new Map<string, Promise<unknown>>();
const libraryWrites = new Set(["library_import", "library_import_file", "library_import_folder", "library_remove", "library_rename", "library_move_to_folder",
  "library_relink", "library_refresh", "source_rescan", "source_relocate", "folder_create", "folder_rename", "folder_delete", "online_import", "apply_wallpaper", "apply_span"]);
export function invalidateLibraryReads(): void {
  pendingReads.delete("library_list"); pendingReads.delete("folder_tree");
}
function read<T>(cmd: string): Promise<T> {
  const pending = pendingReads.get(cmd);
  if (pending) return pending as Promise<T>;
  const request = call<T>(cmd).finally(() => { if (pendingReads.get(cmd) === request) pendingReads.delete(cmd); });
  pendingReads.set(cmd, request);
  return request;
}

export const api = {
  sourceFolders: () => call<SourceFolder[]>("source_folders"),
  sourceRescan: (id: string) => call<ImportReport>("source_rescan", { id }),
  sourceRelocate: (id: string, path: string) => call<ImportReport>("source_relocate", { id, path }),
  sourceRemove: (id: string) => call<void>("source_remove", { id }),
  libraryStorage: () => call<LibraryStorage>("library_storage"),
  cleanupLibraryCaches: () => call<CacheCleanupReport>("library_cache_cleanup"),
  openDataDir: () => call<void>("library_open_data_dir"),
  libraryRefresh: () => call<ImportReport>("library_refresh"),
  libraryRelink: (id: string, path: string) => call<void>("library_relink", { id, path }),
  originalBytes: (id: string) => call<ArrayBuffer | number[]>("wallpaper_original", { id }),
  wallpaperDetails: (id: string) => call<WallpaperDetails>("wallpaper_details", { id }),
  revealWallpaper: (id: string) => call<void>("wallpaper_reveal", { id }),
  onlineSearch: (source: string, query: string, page: number) =>
    call<OnlineSearchResult>("online_search", { source, query, page }),
  onlineImport: (source: string, id: string, folderId: string | null = null) =>
    call<OnlineImportResult>("online_import", { source, id, folderId }),
  listMonitors: () => read<Topology>("list_monitors"),

  applyWallpaper: (wallpaperId: string, target: Target, position: Position) =>
    call<ApplyResult>("apply_wallpaper", {
      req: { wallpaperId, target, position },
    }),

  applySpan: (wallpaperId: string) =>
    call<ApplyResult>("apply_span", { req: { wallpaperId } }),

  libraryList: () => read<Wallpaper[]>("library_list"),

  /** 按文件夹筛选；`folderId` 为 null 时返回未归类的壁纸。 */
  libraryListInFolder: (folderId: string | null, recursive: boolean) =>
    call<Wallpaper[]>("library_list_in_folder", { folderId, recursive }),

  libraryImport: (paths: string[], folderId?: string | null) =>
    call<ImportReport>("library_import", { paths, folderId: folderId ?? null }),

  /** 显式索引一张本机图片，返回新建或已存在的库记录。 */
  libraryImportFile: (path: string, folderId?: string | null) =>
    call<Wallpaper>("library_import_file", { path, folderId: folderId ?? null }),

  libraryRemove: (id: string) => call<void>("library_remove", { id }),

  libraryRename: (id: string, name: string) =>
    call<void>("library_rename", { id, name }),

  libraryMoveToFolder: (id: string, folderId: string | null) =>
    call<void>("library_move_to_folder", { id, folderId }),

  libraryUsage: () => call<[number, number]>("library_usage"),

  /** 预扫描本机目录，得到会导入的图片数量，不写库。 */
  libraryScanFolder: (path: string) => call<FolderScan>("library_scan_folder", { path }),

  /** 把本机目录（递归）导入壁纸库。 */
  libraryImportFolder: (path: string, folderId?: string | null) =>
    call<ImportReport>("library_import_folder", { path, folderId: folderId ?? null }),

  /** 补齐缺失缩略图，返回修复数量。 */
  libraryRepairThumbnails: () => call<number>("library_repair_thumbnails"),

  /**
   * 把任意本地图片转成 data URL。
   *
   * 专用于「系统当前壁纸」：它的路径不由本应用掌控，可能不在 asset 白名单内、
   * 也可能没有扩展名，直接拼 asset 地址会静默加载失败。
   */
  currentWallpaperPreview: (path: string) =>
    call<string>("current_wallpaper_preview", { path }),

  folderTree: () => read<FolderNode[]>("folder_tree"),

  folderCreate: (name: string, parentId: string | null) =>
    call<Folder>("folder_create", { name, parentId }),

  folderRename: (id: string, name: string) =>
    call<void>("folder_rename", { id, name }),

  folderDelete: (id: string) => call<void>("folder_delete", { id }),

  fitAdvice: (wallpaperId: string, identity: string) =>
    call<[boolean, string]>("fit_advice", { wallpaperId, identity }),

  dataDir: () => call<string>("data_dir"),
};

export interface SourceFolder { id: string; path: string; folderId: string | null; available: boolean }
export interface LibraryStorage { count: number; indexedBytes: number; managedBytes: number; thumbnailBytes: number; renderedBytes: number }
export interface CacheCleanupReport { removedFiles: number; freedBytes: number; skippedFiles: number; failedFiles: number }

/**
 * 把库内绝对路径转成可在 <img> 中使用的资源地址。
 *
 * Tauri 2 的 asset 协议在 Windows 上要求路径做百分号编码，
 * 中文与空格必须转义，否则图片加载失败且不报错（只显示空白）。
 */
export function assetUrl(absolutePath: string, revision = 0): string {
  // 已经是可直接使用的 URL（data: / blob: / http:）时原样返回。
  // 真实运行时 thumbPath 一定是本地路径，但界面预览与将来的远程库
  // 可能直接给出 URL，不加这层判断会把 `data:` 拼成非法路径。
  if (/^(data:|blob:|https?:)/i.test(absolutePath)) return absolutePath;
  return `http://asset.localhost/${encodeFsPath(absolutePath)}${revision ? `?v=${revision}` : ""}`;
}

/**
 * 文件系统路径转 URL 路径段。
 *
 * 逐段编码而不是整体编码：整体编码会把 `/` 也转义成 %2F，
 * 导致「路径变成单个文件名」，资源加载 404。
 * 这是中文路径最容易踩的坑，因此单独抽出并只保留这一份实现。
 */
export function encodeFsPath(absolutePath: string): string {
  return absolutePath
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

