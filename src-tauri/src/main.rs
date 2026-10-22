// 阻止 Windows 在 release 构建时弹出额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_wall_deck_lib::run()
}
