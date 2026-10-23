import { useSyncExternalStore } from "react";

export type Decoration = "plain" | "glow" | "grid";
export interface Theme { color: string; decoration: Decoration }
export const THEME_KEY = "wall-deck.appearance.v1";
export const DEFAULT_THEME: Theme = { color: "#246bfa", decoration: "glow" };
export const THEME_COLORS = [
  { name: "湖蓝", color: "#246bfa" }, { name: "松绿", color: "#087f70" },
  { name: "暮紫", color: "#7552c8" }, { name: "玫瑰", color: "#b64168" },
  { name: "琥珀", color: "#986114" }, { name: "石墨", color: "#526173" },
];
const listeners = new Set<() => void>();
function normalize(value: unknown): Theme {
  const item = value && typeof value === "object" ? value as Partial<Theme> : {};
  return {
    color: typeof item.color === "string" && /^#[\da-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : DEFAULT_THEME.color,
    decoration: ["plain", "glow", "grid"].includes(item.decoration ?? "") ? item.decoration! : DEFAULT_THEME.decoration,
  };
}
function readTheme(): Theme {
  try { return normalize(JSON.parse(localStorage.getItem(THEME_KEY) ?? "null")); }
  catch { return { ...DEFAULT_THEME }; }
}
const initialTheme = readTheme();
let snapshot = { applied: initialTheme, draft: initialTheme };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useTheme = () => useSyncExternalStore(subscribe, () => snapshot);

/** 过亮的自定义色用于点缀；交互色自动压暗以保持白字至少 4.5:1 对比度。 */
function paint(theme: Theme) {
  let rgb = [1, 3, 5].map(i => parseInt(theme.color.slice(i, i + 2), 16));
  const luminance = () => rgb.map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
  while (luminance() > .183) rgb = rgb.map(v => Math.floor(v * .94));
  const hex = (values: number[]) => `#${values.map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const mixWhite = (amount: number) => hex(rgb.map(v => v + (255 - v) * amount));
  const [r, g, b] = rgb.map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = delta === 0 ? 210 : (((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60) + 360) % 360;
  const saturation = delta === 0 ? 10 : 27;
  const variables: Record<string, string> = {
    "--accent": hex(rgb), "--accent-hover": hex(rgb.map(v => v * .84)),
    "--accent-soft": mixWhite(.92), "--accent-border": mixWhite(.65), "--accent-light": mixWhite(.65),
    "--theme-rgb": rgb.join(" "), "--sidebar-bg": "#142238",
    "--sidebar-active": `hsl(${hue} ${saturation}% 23%)`, "--sidebar-hover": `hsl(${hue} ${saturation}% 18%)`,
  };
  for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value);
  document.documentElement.dataset.decoration = theme.decoration;
}
function update(next: typeof snapshot) { snapshot = next; paint(next.draft); listeners.forEach(listener => listener()); }
export function previewTheme(theme: Theme) { update({ ...snapshot, draft: normalize(theme) }); }
export function cancelThemePreview() { update({ ...snapshot, draft: snapshot.applied }); }
export function applyTheme() {
  // 先持久化再标记应用成功；存储失败时保留预览并向设置页返回错误。
  localStorage.setItem(THEME_KEY, JSON.stringify(snapshot.draft));
  update({ applied: snapshot.draft, draft: snapshot.draft });
}
paint(snapshot.applied);
