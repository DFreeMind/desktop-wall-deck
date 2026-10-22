# 项目长期记忆

## desktop-wall-deck

Windows 多显示器壁纸管理应用。Tauri 2 + Rust + React + SQLite。

### 硬约束

- **COM STA**：`IDesktopWallpaper` 所有调用必须走 `WallpaperWorker`（单一专属线程），
  禁止在其他线程直接 `CoCreateInstance`。这是 Rust 编译器无法保护的约束，改动时务必注意。
- **持久化 key 用 EDID 逻辑身份**，不用 device path（换端口会变）。
- **壁纸存储用 JPEG(92)**，仅带 alpha 的图用 PNG。别再改回无损，体积会翻倍（有测试断言守着）。
- **「全部应用」默认排除虚拟屏**，否则会覆盖模拟器/串流的独立壁纸。
- 壁纸库统一复制副本到 `%APPDATA%/com.duqimeng.desktopwalldeck`，不引用用户原文件。
- **删除合集只删文件夹，壁纸上移**（挂父级，顶级回到未归类），绝不级联删图。
- **`assetUrl` 必须先放行 `data:`/`blob:`/`http(s):` 前缀**再走 `encodeFsPath`，
  否则 base64 图会被拼成 `asset.localhost/data%3Aimage/...`，表现为全灰且零报错。
- **拓扑画布高度按「最矮的屏 ≥ 130px」反推**，不能按宽度等比算（三屏横排会被压成小方块）。
  文字降级阈值 168 / 118，改小会导致屏名与「未设置」重叠。

### UI 约定

- 不引 UI 组件库、不引图标库。图标写在 `src/components/icons.tsx`（24×24、1.5 描边）。
- 禁用 `window.prompt` / `window.confirm`，统一用 `src/components/dialogs.tsx`。
- 三栏：196px 导航 + 内容区 + 288px 右栏。

### 验证方式（重要）

**沙箱下 WebView2 不可用**（debug 崩 CrashSender、release 渲染空白），不要浪费时间做原生截图。
UI 验证走打桩 harness：`src/preview.tsx` 给 `__TAURI_INTERNALS__.invoke` 打桩，
浏览器渲染同一份 `App` 组件，再用 Playwright（绝对路径引用全局安装的包）截图与断言。
这些文件在 `.gitignore` 里，是本地工具不入库。

### 开发命令

```bash
npm run tauri dev     # 开发
npm run tauri build   # 打包（产物在 src-tauri/target/release/bundle/nsis/）
cargo test --manifest-path src-tauri/Cargo.toml   # 全部测试
```

注意：`cargo test` 里的 `e2e_apply` 会真实修改桌面壁纸（有恢复逻辑），单人环境可跑，
勿在他人机器上运行。

### 已知后续可做的事

- 轮播（含多屏错峰）、壁纸标签、右键菜单「设为当前屏壁纸」、托盘常驻与开机自启
- 合集拖拽排序、合集内批量选择
- 完善 EDID 序列号解析（当前用 device path 的 UID 段近似，同型号双屏同端口时可能冲突）
