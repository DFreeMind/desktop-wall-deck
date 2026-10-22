import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../components/WallpaperGrid";
import { IconFolder, IconMonitor } from "../components/icons";

interface Props {
  totalCount: number;
  monitorCount: number;
  virtualCount: number;
  showVirtual: boolean;
  onShowVirtualChange: (v: boolean) => void;
  onNotify: (msg: string, kind?: "info" | "success" | "warn" | "error") => void;
}

/** 设置页。只放真正需要用户决定的选项，不做「关于」之类的填充内容。 */
export function SettingsView({
  totalCount,
  monitorCount,
  virtualCount,
  showVirtual,
  onShowVirtualChange,
  onNotify,
}: Props) {
  const [dir, setDir] = useState("");
  const [usage, setUsage] = useState<[number, number] | null>(null);

  useEffect(() => {
    void api.dataDir().then(setDir).catch(() => setDir(""));
    void api
      .libraryUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p className="page-sub">显示与存储相关选项</p>
        </div>
      </header>

      <section className="setting-group">
        <h2 className="setting-title">
          <IconMonitor size={15} />
          显示器
        </h2>
        <div className="setting-row">
          <div className="setting-label">
            <span>在布局中显示虚拟屏幕</span>
            <p>
              检测到 {virtualCount} 块虚拟显示器（模拟器、串流、远程桌面等）。
              默认隐藏以免干扰布局，开启后可单独为其设置壁纸。
            </p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={showVirtual}
              disabled={virtualCount === 0}
              onChange={(e) => onShowVirtualChange(e.target.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </label>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span>已检测显示器</span>
            <p>当前可见 {monitorCount} 块。热插拔后壁纸会自动按显示器身份重新应用。</p>
          </div>
          <span className="setting-value">{monitorCount}</span>
        </div>
      </section>

      <section className="setting-group">
        <h2 className="setting-title">
          <IconFolder size={15} />
          存储
        </h2>
        <div className="setting-row">
          <div className="setting-label">
            <span>壁纸库占用</span>
            <p>导入的图片会复制进库目录并统一转码，删除原始文件不会影响壁纸。</p>
          </div>
          <span className="setting-value">
            {usage ? `${usage[0]} 张 · ${formatBytes(usage[1])}` : `${totalCount} 张`}
          </span>
        </div>
        <div className="setting-row column">
          <div className="setting-label">
            <span>库位置</span>
            <p className="mono-path">{dir || "读取中…"}</p>
          </div>
          <button
            className="ghost"
            onClick={() => {
              if (!dir) return;
              void navigator.clipboard
                .writeText(dir)
                .then(() => onNotify("路径已复制", "success"))
                .catch(() => onNotify("复制失败，请手动选择文本", "error"));
            }}
          >
            复制路径
          </button>
        </div>
      </section>
    </div>
  );
}
