//! One window picker for Instant Replay, preview, and the compositor.
//!
//! A capturable window is visible, not cloaked, and has area. When the
//! foreground window belongs to the target process, that window wins.
//! Otherwise the largest remaining window wins.

/// Process IDs in `pids` that currently own a capturable window.
pub fn pids_with_capturable_window(pids: &[u32]) -> Vec<u32> {
    #[cfg(windows)]
    {
        windows_impl::pids_with_capturable_window(pids)
    }
    #[cfg(not(windows))]
    {
        let _ = pids;
        Vec::new()
    }
}

#[cfg(windows)]
pub fn window_for_pid(pid: u32) -> Option<windows_capture::window::Window> {
    windows_impl::window_for_pid(pid)
}

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_capture::window::Window;

    pub fn window_for_pid(pid: u32) -> Option<Window> {
        if pid == 0 {
            return None;
        }
        if let Ok(foreground) = Window::foreground() {
            if capturable(&foreground) && foreground.process_id().ok() == Some(pid) {
                return Some(foreground);
            }
        }
        let windows = Window::enumerate().ok()?;
        windows
            .into_iter()
            .filter(|window| capturable(window) && window.process_id().ok() == Some(pid))
            .max_by_key(area)
    }

    pub fn pids_with_capturable_window(pids: &[u32]) -> Vec<u32> {
        if pids.is_empty() {
            return Vec::new();
        }
        let Ok(windows) = Window::enumerate() else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for window in windows {
            if !capturable(&window) {
                continue;
            }
            let Ok(pid) = window.process_id() else {
                continue;
            };
            if pids.contains(&pid) && !found.contains(&pid) {
                found.push(pid);
            }
        }
        found
    }

    fn capturable(window: &Window) -> bool {
        window.is_valid() && !cloaked(window) && area(window) > 0
    }

    fn area(window: &Window) -> u32 {
        let width = window.width().unwrap_or(0).max(0) as u32;
        let height = window.height().unwrap_or(0).max(0) as u32;
        width.saturating_mul(height)
    }

    fn cloaked(window: &Window) -> bool {
        let hwnd = HWND(window.as_raw_hwnd());
        let mut cloaked = 0u32;
        let status = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        status.is_ok() && cloaked != 0
    }
}
