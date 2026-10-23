import { useSyncExternalStore } from "react";

let revision = 0;
let snapshot = { all: 0, byId: new Map<string, number>() };
const listeners = new Set<() => void>();
window.addEventListener("wallpaper-thumbnails-repaired", (event) => {
  revision += 1;
  const ids = (event as CustomEvent<string[] | undefined>).detail;
  if (Array.isArray(ids)) {
    const byId = new Map(snapshot.byId);
    ids.forEach((id) => byId.set(id, revision));
    snapshot = { ...snapshot, byId };
  } else { snapshot = { all: revision, byId: new Map() }; }
  listeners.forEach((listener) => listener());
});
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** 后台补齐缩略图后换 URL，避免 WebView 继续复用先前的 404 响应。 */
export function useThumbnailRevision(): typeof snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const thumbnailVersion = (value: typeof snapshot, id: string): number => Math.max(value.all, value.byId.get(id) ?? 0);
