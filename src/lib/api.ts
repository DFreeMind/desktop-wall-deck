/**
 * 后端命令封装。
 *
 * 所有 invoke 集中在此，组件不直接触碰命令名，改名时只需改一处。
 * 统一把后端返回的错误字符串抛成 Error，便于上层用 try/catch 处理。
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  ImportReport,
  Position,
  Target,
  Topology,
  Wallpaper,
} from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // 后端统一返回 String，这里原样抛出保留中文提示
    throw new Error(typeof e === "string" ? e : String(e));
  }
}

export const api = {
  listMonitors: () => call<Topology>("list_monitors"),

  applyWallpaper: (wallpaperId: string, target: Target, position: Position) =>
    call<ApplyResult>("apply_wallpaper", {
      req: { wallpaperId, target, position },
    }),

  applySpan: (wallpaperId: string, position: Position) =>
    call<ApplyResult>("apply_span", { req: { wallpaperId, position } }),

  libraryList: () => call<Wallpaper[]>("library_list"),

  libraryImport: (paths: string[]) =>
    call<ImportReport>("library_import", { paths }),

  libraryRemove: (id: string) => call<void>("library_remove", { id }),

  libraryRename: (id: string, name: string) =>
    call<void>("library_rename", { id, name }),

  libraryUsage: () => call<[number, number]>("library_usage"),

  fitAdvice: (wallpaperId: string, identity: string) =>
    call<[boolean, string]>("fit_advice", { wallpaperId, identity }),

  dataDir: () => call<string>("data_dir"),
};

/**
 * 把库内绝对路径转成可在 <img> 中使用的资源地址。
 *
 * Tauri 2 的 asset 协议在 Windows 上要求路径做百分号编码，
 * 中文与空格必须转义，否则图片加载失败且不报错（只显示空白）。
 */
export function assetUrl(absolutePath: string): string {
  return `http://asset.localhost/${encodeFsPath(absolutePath)}`;
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

