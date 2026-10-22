# AGENTS.md

本项目为 Windows 桌面壁纸管理应用。本文件面向参与开发的 AI Agent 与人类开发者，描述项目结构、技术约束与工作规范。

## 项目定位

一个可替代 Windows 系统「个性化 → 背景」的壁纸管理工具，核心能力：

- 枚举真实显示器，按物理排列绘制拓扑图
- 为单台显示器、指定多台、或全部显示器设置壁纸
- 本地壁纸库：导入、扫描、缩略图、标签、删除
- 跨屏拼接：一张图按各屏几何切分后分别投放
- 显示器热插拔后按逻辑身份恢复映射

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
  library/          壁纸库：导入、扫描、缩略图、索引
  mapping/          显示器逻辑身份与持久化映射
  commands.rs       Tauri 命令入口（前端唯一调用面）
  state.rs          应用全局状态
src/
  components/       通用组件
  views/            页面级视图
  hooks/            数据与事件钩子
  lib/              纯函数工具
```

分层规则：`commands.rs` 只做参数校验与状态编排，业务逻辑下沉到各模块；`wallpaper` 层不依赖 `library` 层，两者通过 `commands.rs` 组合。

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

监听 `WM_DISPLAYCHANGE`（或 Tauri 的显示器变更事件），拓扑变化后重新枚举并在短暂延迟后按映射重放一次，抵消 Windows 在断开显示器时的自动重排。

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
cargo check --manifest-path src-tauri/Cargo.toml   # 仅检查 Rust 编译
```

## 已知边界

- 仅支持 Windows 8 及以上（`IDesktopWallpaper` 最低要求）
- 不支持动态壁纸（视频/HTML），需注入宿主进程，不在当前范围
- 不做壁纸下载与在线资源，只管理本地文件
