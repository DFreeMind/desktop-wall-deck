/**
 * 壁纸站点的固定清单。
 *
 * 只收录明确不主张图片版权、或官方提供免费壁纸下载的站点，
 * 并且**全部外链到系统浏览器**——不做内置浏览器，也不做抓取下载。
 * 理由：这些站点的图片授权条款各不相同（有的仅限个人使用），
 * 在应用内一键下载会把「用户自己去网站确认条款」这一步抹掉，风险不透明。
 * 让用户在浏览器里看到原始页面和授权说明，是更诚实的做法。
 */

export interface WallpaperSource {
  id: string;
  name: string;
  url: string;
  /** 一句话说明这个站的特点，帮助用户判断值不值得点 */
  blurb: string;
  /** 站点允许的用途，用于提示授权差异 */
  license: string;
  tags: string[];
}

export const WALLPAPER_SOURCES: WallpaperSource[] = [
  {
    id: "unsplash",
    name: "Unsplash",
    url: "https://unsplash.com/s/photos/wallpaper",
    blurb: "全球最大的高质量摄影图库，4K 以上素材丰富，搜索「4K wallpaper」效果最好。",
    license: "免费可商用，无需署名",
    tags: ["摄影", "4K", "极简"],
  },
  {
    id: "wallhaven",
    name: "Wallhaven",
    url: "https://wallhaven.cc/",
    blurb: "按分辨率、宽高比筛选的老牌壁纸站，特别适合给竖屏或超宽屏找图。",
    license: "多为转载，商用前需查单图",
    tags: ["按分辨率筛选", "多屏", "动漫"],
  },
  {
    id: "wikimedia",
    name: "维基共享资源",
    url: "https://commons.wikimedia.org/wiki/Category:Wallpapers",
    blurb: "公有领域与自由许可图片的归档站，来源可追溯，适合需要合规素材的场景。",
    license: "自由许可，附来源与署名要求",
    tags: ["公有领域", "合规", "纪实"],
  },
  {
    id: "desktopography",
    name: "Desktopography",
    url: "https://www.desktopography.net/",
    blurb: "一年一度的数字艺术壁纸展览，风格统一、多为抽象与自然题材，数量少但张张可用。",
    license: "仅限个人桌面使用",
    tags: ["数字艺术", "策展", "抽象"],
  },
  {
    id: "nasa",
    name: "NASA Image Library",
    url: "https://images.nasa.gov/",
    blurb: "真实的太空、地球与深空影像，大尺寸原图可下，深色系很适合做壁纸。",
    license: "多数为公有领域",
    tags: ["深空", "地球", "深色"],
  },
  {
    id: "pexels",
    name: "Pexels",
    url: "https://www.pexels.com/search/4k%20wallpaper/",
    blurb: "免费素材库中的壁纸专区，中文关键词也能搜到结果，下载无需登录。",
    license: "免费可商用",
    tags: ["中文搜索", "免登录", "摄影"],
  },
];
