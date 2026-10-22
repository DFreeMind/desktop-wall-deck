# AGENTS.md

本项目为 Windows 桌面壁纸管理应用。本文件面向参与开发的 AI Agent 与人类开发者，描述项目结构、技术约束与工作规范。

## 项目定位

一个可替代 Windows 系统「个性化 → 背景」的壁纸管理工具，核心能力：

- 枚举真实显示器，按物理排列绘制拓扑图
- 为单台显示器、指定多台、或全部显示器设置壁纸
- 本地壁纸库：导入、扫描、缩略图、删除
- 多级文件夹（合集）：新建、重命名、删除、按文件夹筛选、穿透查看子文件夹
- 跨屏拼接：一张图按各屏几何切分后分别投放
- 显示器热插拔后按逻辑身份恢复映射
- 知名开源壁纸站外链导航（只跳系统浏览器，不抓取内容）

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面外壳 | Tauri 2 | 单实例、托盘、自启、体积小 |
| 系统调用 | Rust + `windows` crate | 直连 COM `IDesktopWallpaper`，不做 FFI 中间层 |
| 前端 | React 18 + TypeScript + Vite | 拓扑画布与瀑布流依赖成熟的 DOM 生态 |
| 持久化 | SQLite（`rusqlite`，bundled） | 壁纸元数据与显示器身份映射 |
| 图像处理 | `image` + `kamadak-exif` | 缩略图、EXIF 方向校正、跨屏切分 |

## 目录约定

```
src-tauri/src/
  wallpaper/        系统适配层：COM 封装、显示器枚举、壁纸投放
  library/          壁纸库：导入、扫描、缩略图、索引、文件夹树
  mapping/          显示器逻辑身份与持久化映射
  commands.rs       Tauri 命令入口（前端唯一调用面）
  state.rs          应用全局状态
src/
  components/       通用组件（SideNav / TopologyCanvas / WallpaperGrid / MonitorPanel / dialogs / icons）
  views/            页面级视图（App 主壳 + Collections / Sources / Settings）
  hooks/            数据与事件钩子
  lib/              纯函数工具（api / types / wallpaperSources）
```

分层规则：`commands.rs` 只做参数校验与状态编排，业务逻辑下沉到各模块；`wallpaper` 层不依赖 `library` 层，两者通过 `commands.rs` 组合。

前端不引入 UI 组件库，也不引入图标库：图标统一写在 `src/components/icons.tsx`（24×24、1.5 描边、`currentColor`），弹窗统一走 `src/components/dialogs.tsx`（`PromptDialog` / `MoveDialog` / `ConfirmDialog`），禁用 `window.prompt` / `window.confirm`，因为 Tauri 的 WebView2 里原生弹窗样式不可控。

## 关键技术约束（务必遵守）

### 1. COM 线程模型

`IDesktopWallpaper` 必须在 **STA** 线程上创建和使用，且不能跨线程传递接口指针。所有壁纸操作统一走单一 `WallpaperActor` 线程：主线程通过 channel 发送请求，actor 在 STA 线程内初始化 COM 并串行执行。禁止在多个线程各自 `CoInitializeEx` 后并发调用。

### 2. monitorId 不稳定

`GetMonitorDevicePathAt` 返回形如 `\\?\DISPLAY#LEN8AB1#4&3798061&0&UID8388688#{...}` 的设备路径，与端口和硬件绑定。换线、换口、驱动重装后可能变化。因此：

- 持久化必须存**逻辑身份**（EDID 制造商码 + 产品码 + 序列号），而非原始设备路径
- 启动与拓扑变化时重新枚举，用逻辑身份匹配历史映射
- 匹配失败的设计为「未绑定」状态，不静默套用错误的壁纸

### 3. 虚拟显示器

机器上可能存在 MuMu / 向日葵 / GameViewer 等虚拟显示适配器，会出现在 `GetMonitorDevicePathCount` 结果中。识别特征：设备路径含 `IDD`、`Virtual`、`Root`，或无 EDID 信息。UI 默认折叠虚拟屏并提供开关，避免污染主流程。

### 4. SetWallpaper 要求绝对路径且文件必须存在

库内壁纸统一复制进 app data 目录管理，投放时使用库内副本的绝对路径。禁止直接引用用户原始目录，否则源文件删除后壁纸失效。

### 5. 全部应用用 null，不要循环

「所有显示器同一张图」应调用 `SetWallpaper(NULL, path)`，语义是系统级统一壁纸。循环逐屏设置会导致后续插入新显示器时新屏无壁纸。仅在需要**逐屏不同**时才传具体 monitorId。

### 6. 跨屏拼接不用 SetPosition(SPAN)

`SPAN` 只在各屏构成连续矩形时正确。多屏纵向偏移不同时会出现黑边。正确实现：按各屏 RECT 从拼接大图裁切分片，生成临时文件后逐屏投放。

### 7. 拓扑变化监听

监听 `WM_DISPLAYCHANGE`（见 `display_watch.rs`），拓扑变化后延迟 1.5 秒重新枚举再按映射重放一次，
抵消 Windows 在断开显示器时的自动重排。延迟是必要的：立刻读取往往拿到中间态。

### 8. 壁纸存储格式

统一转 JPEG（质量 92），**不要改回 PNG**。实测同样 3 张壁纸：PNG 存储 12.9MB，
JPEG 存储 2.09MB，而屏幕上无法分辨。带透明通道的图才保留 PNG（JPEG 不支持 alpha）。
`tests/e2e_import.rs` 里有体积回归断言守着这条。

### 9. 平台 API 的 feature 门控

`windows` crate 的 API 由 Cargo feature 控制，缺失时表现为「模块里找不到这个函数」，
容易误判为版本不对。已知：`RegisterClassW` / `WNDCLASSW` 需要 `Win32_Graphics_Gdi`。
`CreateWindowExW` 的 `hinstance` 是泛型 `Param<HINSTANCE>`，必须传裸 `HINSTANCE` 而非 `Option`。
`GetModuleHandleW` 返回 `HMODULE`，转 `HINSTANCE` 需显式 `HINSTANCE(h.0)`。
另外 `tray-icon` 之外，前端要显示本地图片必须开 `protocol-asset`：

```toml
tauri = { version = "2", features = ["tray-icon", "image-png", "protocol-asset"] }
```

且 `tauri.conf.json` 里 `app.security.assetProtocol` 需同时设 `enable: true` 与 `scope`，只设其一都表现为图片静默加载失败。

### 10. 删除文件夹时壁纸上移，不要级联删除

`folders.id` 上虽然有 `ON DELETE CASCADE` 指向 `parent_id`（删父级时子级跟着删），但**壁纸绝不能跟着删**。用户删掉一个合集，只是放弃这个分类，不是要销毁图片。正确行为在事务内完成：

1. 该文件夹内的壁纸 `folder_id` 置为其父级（顶级则置 `NULL`）
2. 子文件夹的 `parent_id` 上移一级挂到祖父级
3. 再删除该文件夹行

`service.rs` 里 `删除文件夹时壁纸上移而非连带删除` 这条测试守着这个行为，改动时不要绕过它。

### 11. `assetUrl` 必须放行 `data:` / `blob:` / `http(s):` 前缀

`encodeFsPath` 是逐段 URL 编码（见「常见故障」第二条），它对任何输入都会拼成 `http://asset.localhost/...`。所以 `assetUrl()` 在编码前必须先判断：已经是 `data:` / `blob:` / `http(s):` 的字符串原样返回。否则预览 harness 的 base64 缩略图会被拼成 `http://asset.localhost/data%3Aimage/png...`，表现为缩略图全部灰块、`naturalWidth === 0`、控制台无任何报错——很难往编码问题上想。

### 12. 拓扑画布高度按「最矮的屏 ≥ 130px」反推

三屏横排的包围盒极其扁（例如 3072×1920 + 1080p + 竖屏横排，`bh` 相对 `bw` 很小）。若直接按 `canvasH = (availW / bw) * bh` 等比适配宽度，算出的高度只有两百来像素，显示器会被压成小方块，「未设置」提示和图标都放不下。

正确做法：先求各屏高度归一后的最小值 `minRatio`，再解 `MIN_SCREEN_H / minRatio + PAD * 2`，与上下限 `[MIN_H, MAX_H]` 取夹逼。`MIN_SCREEN_H = 130`，改小会让空屏提示挤成一团。

配套的降级阈值也必须保留，否则窄屏上文字会与屏名重叠：

| 元素 | 显示条件 |
|---|---|
| 「未设置」图标 `BlankGlyph` | `height >= 118 && width >= 96` |
| 「未设置」两行文字 | `height >= 168 && width >= 104` |
| 放不下时 | 降级为底部一行 `.screen-blank-note` 水印 |

`.screen-blank-inner` 需留 `padding: 6px 6px 26px` 给底部屏名标签让位。

## 工作规范

- 分支开发，不直接改 `main`。功能分支命名 `feature/<主题>`。
- 提交信息用**中文**，格式：`<类型>: <简述>`，类型取 `feat` / `fix` / `refactor` / `docs` / `chore`。
- 每次提交应可编译通过。
- 涉及系统调用的代码必须保留错误分支，`HRESULT` 失败时向上返回可读错误，不做 `unwrap`。
- 新增 Tauri 命令需在 `commands.rs` 注册并同步前端类型声明。

## 常用命令

```bash
npm run dev          # 前端开发服务
npm run tauri dev    # 完整应用开发模式（含 Rust 热重载）
npm run tauri build  # 生产构建

cargo check --manifest-path src-tauri/Cargo.toml        # 仅检查 Rust 编译
cargo test --manifest-path src-tauri/Cargo.toml         # 全部测试
cargo test --manifest-path src-tauri/Cargo.toml --lib   # 仅单元测试（快）
```

## 测试说明

- `--lib` 单元测试：身份解析、虚拟屏识别、比例提示、库导入去重与删除、**文件夹嵌套与穿透查询、删文件夹壁纸上移、同级重名拒绝、移动到文件夹/移回根目录**，全部使用临时目录，无副作用。
- `tests/e2e_import.rs`：拿 `C:\Users\qiulu\Desktop\imgs\壁纸` 下的真实图片走完整导入链路，
  校验副本格式与体积。样本不存在时自动跳过。
- `tests/e2e_apply.rs`：**会真实修改桌面壁纸**。只动索引 0 的显示器，且无论断言成败都会恢复原壁纸。
  在他人机器上运行前请确认这一点。

### 前端视觉与交互校验

本机沙箱环境下 WebView2 不可靠（debug 版崩溃、release 版窗口空白），**不要试图用原生截图验证界面**。可用的替代方案是打桩的预览 harness：

- `src/preview.tsx` 给 `window.__TAURI_INTERNALS__.invoke` 打桩，用 switch 模拟全部命令
- `src/lib/mockData.ts` 用 canvas 生成渐变缩略图
- 这样渲染的是**同一份** `App` 组件，与真实界面共用样式与布局，而非另写一个预览页

这些文件都在 `.gitignore` 里，属于本地调试工具，不入库。改动 UI 前先确认 harness 能跑起来，否则改完没有任何可视化反馈。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建报 `icons/icon.ico not found` | 缺应用图标 | 确认 `src-tauri/icons/` 下存在 icon.ico 与 icon.png |
| 界面图片全空白，控制台无报错 | 中文路径未逐段 URL 编码 | 检查 `encodeFsPath`，不能整体 `encodeURIComponent`（会把 `/` 也编码） |
| 缩略图全灰块、`naturalWidth === 0` | `assetUrl` 没放行 `data:` 前缀 | 见上文约束 11 |
| 图片 403 / 加载失败但路径正确 | 缺 `assetProtocol.scope` 或 Cargo feature | `tauri.conf.json` 的 `enable` + `scope`，加 Cargo 的 `protocol-asset` |
| 显示器缩成小方块、提示文字挤在一起 | 画布高度按宽度等比算 | 见上文约束 12 |
| `cargo check` 说找不到 `RegisterClassW` | 缺 `Win32_Graphics_Gdi` feature | 见上文约束 9 |
| 所有屏壁纸被重置成同一张 | Windows 在显示器断开时的重排行为 | 拓扑监听应重放绑定，检查 `topology_watch` 日志 |
| 卡片「更多」按钮点不到 | `opacity: 0` 被判为不可见 | 基线用 `opacity: 0.42`，hover/focus 提到 1，另加 `@media (hover: none)` |

## 已知边界

- 仅支持 Windows 8 及以上（`IDesktopWallpaper` 最低要求）
- 不支持动态壁纸（视频/HTML），需注入宿主进程，不在当前范围
- 不做壁纸下载与在线资源抓取，只管理本地文件；「壁纸来源」页仅提供外链跳转
- 沙箱环境下 WebView2 渲染不可靠，UI 验证走预览 harness（见「前端视觉与交互校验」）
