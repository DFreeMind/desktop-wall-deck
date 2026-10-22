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

### 开发命令

```bash
npm run tauri dev     # 开发
npm run tauri build   # 打包（产物在 src-tauri/target/release/bundle/nsis/）
cargo test --manifest-path src-tauri/Cargo.toml   # 全部测试
```

注意：`cargo test` 里的 `e2e_apply` 会真实修改桌面壁纸（有恢复逻辑），单人环境可跑，
勿在他人机器上运行。

### 已知后续可做的事

- 轮播（含多屏错峰）、壁纸集合与标签、右键菜单「设为当前屏壁纸」、托盘常驻与开机自启
- 完善 EDID 序列号解析（当前用 device path 的 UID 段近似，同型号双屏同端口时可能冲突）
