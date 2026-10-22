/**
 * 壁纸站点的固定清单。
 *
 * 全部在**应用内**加载（内嵌浏览），不再跳系统浏览器：
 * 用户在应用里选图、确认、再导入库，是一条连续的动作链，
 * 中途被切到浏览器会丢掉上下文。
 *
 * # 关于「能否被嵌入」
 *
 * 内嵌依赖站点不设置 `X-Frame-Options: DENY/SAMEORIGIN`，
 * 也不在 CSP 里用 `frame-ancestors` 禁止外部框架。实测：
 *
 * - Unsplash / Wallhaven / NASA / Wikimedia：未设置限制，可嵌入
 * - Pexels：`X-Frame-Options: SAMEORIGIN`，**无法嵌入**
 *
 * 因此每个站点带一个 `embeddable` 标记。不可嵌入的站点在应用内
 * 给出明确说明，而不是留一块白屏让用户以为坏了。
 */

export interface WallpaperSource {
  id: string;
  name: string;
  url: string;
  /** 一句话说明这个站的特点，帮助用户判断值不值得看 */
  blurb: string;
  /** 站点允许的用途，用于提示授权差异 */
  license: string;
  tags: string[];
  /** 该站点是否允许被嵌入到第三方页面。false 时只能提示用户在浏览器打开 */
  embeddable: boolean;
  /** 站点主页，用于按钮回退 */
  home: string;
}

export const WALLPAPER_SOURCES: WallpaperSource[] = [
  {
    id: "unsplash",
    name: "Unsplash",
    url: "https://unsplash.com/s/photos/wallpaper",
    home: "https://unsplash.com/",
    blurb: "全球最大的高质量摄影图库，4K 以上素材丰富，搜索「4K wallpaper」效果最好。",
    license: "免费可商用，无需署名",
    tags: ["摄影", "4K", "极简"],
    embeddable: true,
  },
  {
    id: "wallhaven",
    name: "Wallhaven",
    url: "https://wallhaven.cc/",
    home: "https://wallhaven.cc/",
    blurb: "按分辨率、宽高比筛选的老牌壁纸站，特别适合给竖屏或超宽屏找图。",
    license: "多为转载，商用前需查单图",
    tags: ["按分辨率筛选", "多屏", "动漫"],
    embeddable: true,
  },
  {
    id: "wikimedia",
    name: "维基共享资源",
    url: "https://commons.wikimedia.org/wiki/Category:Wallpapers",
    home: "https://commons.wikimedia.org/",
    blurb: "公有领域与自由许可图片的归档站，来源可追溯，适合需要合规素材的场景。",
    license: "自由许可，附来源与署名要求",
    tags: ["公有领域", "合规", "纪实"],
    embeddable: true,
  },
  {
    id: "desktopography",
    name: "Desktopography",
    url: "https://www.desktopography.net/",
    home: "https://www.desktopography.net/",
    blurb: "一年一度的数字艺术壁纸展览，风格统一、多为抽象与自然题材，数量少但张张可用。",
    license: "仅限个人桌面使用",
    tags: ["数字艺术", "策展", "抽象"],
    embeddable: true,
  },
  {
    id: "nasa",
    name: "NASA Image Library",
    url: "https://images.nasa.gov/",
    home: "https://images.nasa.gov/",
    blurb: "真实的太空、地球与深空影像，大尺寸原图可下，深色系很适合做壁纸。",
    license: "多数为公有领域",
    tags: ["深空", "地球", "深色"],
    embeddable: true,
  },
  {
    id: "pexels",
    name: "Pexels",
    url: "https://www.pexels.com/search/4k%20wallpaper/",
    home: "https://www.pexels.com/",
    blurb: "免费素材库中的壁纸专区，中文关键词也能搜到结果，下载无需登录。",
    license: "免费可商用",
    tags: ["中文搜索", "免登录", "摄影"],
    // Pexels 返回 X-Frame-Options: SAMEORIGIN，内嵌必然被拒绝
    embeddable: false,
  },
];

export function sourceById(id: string): WallpaperSource | undefined {
  return WALLPAPER_SOURCES.find((s) => s.id === id);
}
