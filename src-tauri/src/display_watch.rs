//! Windows 显示配置变化监听。
//!
//! 通过隐藏窗口接收 `WM_DISPLAYCHANGE` 消息。这里不用 Tauri 主窗口，
//! 因为壁纸应用可能被最小化到托盘甚至关闭窗口，独立隐藏消息窗口更稳妥。

#[cfg(windows)]
pub fn spawn_listener(tx: crossbeam_channel::Sender<()>) {
    use std::thread;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW,
        SetWindowLongPtrW, TranslateMessage, GWLP_USERDATA, MSG, WINDOW_EX_STYLE, WNDCLASSW,
        WS_OVERLAPPED,
    };

    thread::Builder::new()
        .name("display-change-hook".into())
        .spawn(move || unsafe {
            let hmodule = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(_) => return,
            };
            // 0.58 中 GetModuleHandleW 返回 HMODULE，WNDCLASSW 需要 HINSTANCE，
            // 两者都是句柄的薄包装，可直接以内部指针构造。
            let hinstance = HINSTANCE(hmodule.0);

            let class_name: Vec<u16> = "DesktopWallDeckWatcher\0".encode_utf16().collect();

            let wc = WNDCLASSW {
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance,
                lpszClassName: PCWSTR::from_raw(class_name.as_ptr()),
                ..Default::default()
            };

            if RegisterClassW(&wc) == 0 {
                // 重复注册（如多实例）时直接退出，不影响主流程
                return;
            }

            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                PCWSTR::from_raw(class_name.as_ptr()),
                PCWSTR::null(),
                // 不指定 WS_VISIBLE，即为隐藏窗口
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                // hwndparent / hmenu 传 null；hinstance 必须是具体 HINSTANCE，
                // 不能包成 Option，否则不满足 Param<HINSTANCE> 约束
                None,
                None,
                hinstance,
                None,
            ) {
                Ok(h) => h,
                Err(_) => return,
            };

            // 把 channel 发送端挂到窗口 user data，供窗口过程取用。
            // 该内存故意不回收：线程随进程存活，释放反而引入悬垂指针风险。
            let boxed = Box::new(tx);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(boxed) as isize);

            let mut msg = MSG::default();
            // GetMessageW 返回 BOOL，0 表示 WM_QUIT，-1 表示错误，均结束循环
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .ok();
}

/// 窗口过程：只处理显示配置变化，其余交还系统默认。
#[cfg(windows)]
unsafe extern "system" fn wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, GetWindowLongPtrW, GWLP_USERDATA, WM_DISPLAYCHANGE,
    };

    if msg == WM_DISPLAYCHANGE {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const crossbeam_channel::Sender<()>;
        if !ptr.is_null() {
            // try_send 不阻塞消息循环；队列已满说明有待处理事件，丢弃新事件即可
            let _ = (*ptr).try_send(());
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[cfg(not(windows))]
pub fn spawn_listener(_tx: crossbeam_channel::Sender<()>) {
    // 仅 Windows 支持
}
