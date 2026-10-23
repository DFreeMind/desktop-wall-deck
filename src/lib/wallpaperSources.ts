/** 通过公开接口接入的图库，与需要额外授权的站点入口分别标记。 */
export interface WallpaperSource {
  id: string;
  name: string;
  home: string;
  blurb: string;
  license: string;
  online: boolean;
}

export const WALLPAPER_SOURCES: WallpaperSource[] = [
  { id: "wallhaven", name: "Wallhaven", home: "https://wallhaven.cc/", online: true,
    blurb: "热门高清壁纸，默认展示安全级别内容。支持英文关键词搜索。", license: "单图版权依原始来源" },
  { id: "nasa", name: "NASA 影像", home: "https://images.nasa.gov/", online: true,
    blurb: "太空、星云与地球影像。可搜索 nebula、earth、moon 等关键词。", license: "NASA 媒体使用规范" },
  { id: "wikimedia", name: "维基共享资源", home: "https://commons.wikimedia.org/", online: true,
    blurb: "可追溯来源的自由许可图片，支持中英文搜索。", license: "每张图片保留独立许可与署名要求" },
  { id: "unsplash", name: "Unsplash", home: "https://unsplash.com/s/photos/wallpaper", online: false,
    blurb: "自动加载需要配置 Unsplash 应用密钥，当前保留官网入口。下载后可从壁纸库导入。", license: "使用前查看原图许可" },
  { id: "pexels", name: "Pexels", home: "https://www.pexels.com/search/wallpaper/", online: false,
    blurb: "此来源未接入自动图库，当前提供官网入口。可在网站浏览并下载后，从壁纸库导入。", license: "使用前查看原图许可" },
  { id: "desktopography", name: "Desktopography", home: "https://www.desktopography.net/", online: false,
    blurb: "数字艺术壁纸展览，尚未接入公开图库接口。可前往官网浏览并下载。", license: "以作品原页许可为准" },
];
