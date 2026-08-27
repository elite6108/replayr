//! External, click-through “Clip saved” overlay.
//!
//! Isolated from capture/encoding. Recording code should only call
//! [`notify_clip_saved`] after a clip has been fully written.
//!
//! This is a top-level Replayr window. It does not inject into games, hook
//! graphics APIs, or modify game memory. Exclusive-fullscreen titles may cover
//! it; borderless/windowed is the supported case.

use serde::Serialize;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Logical overlay size and inset, before per-monitor DPI scaling.
pub const OVERLAY_WIDTH_LOGICAL: f64 = 320.0;
pub const OVERLAY_HEIGHT_LOGICAL: f64 = 78.0;
pub const OVERLAY_MARGIN_LOGICAL: f64 = 24.0;

const OVERLAY_LABEL: &str = "clip-overlay";
const VISIBLE_MS: u64 = 2000;
const FADE_MS: u64 = 220;

/// `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on the overlay HWND only.
///
/// Flip to `false` if monitor capture starts showing black regions. Do not
/// change the WGC/capture pipeline to compensate.
const APPLY_CAPTURE_EXCLUSION: bool = true;

/// Hint used to pick a monitor at *show* time. The live game window is
/// preferred; `last_monitor` is only a fallback rect, never a cached HMONITOR.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlacementHint {
    pub pid: Option<u32>,
    pub last_monitor: Option<MonitorInfo>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Extensible notification kinds. V1 implements ClipSaved only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayNotification {
    ClipSaved { duration_seconds: Option<u32> },
}

struct OverlayManager {
    generation: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum DpiAwareness {
    Unaware,
    System,
    PerMonitor,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayShowPayload {
    kind: OverlayKind,
    duration_seconds: Option<u32>,
    generation: u64,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum OverlayKind {
    ClipSaved,
}

pub fn prepare(app: &AppHandle) {
    app.manage(OverlayManager {
        generation: AtomicU64::new(0),
    });
    #[cfg(windows)]
    if let Err(err) = windows_impl::ensure_window(app) {
        tracing::warn!("clip overlay window was not prepared: {err}");
    }
}

pub fn hint_from_pid(pid: Option<u32>) -> PlacementHint {
    PlacementHint {
        pid,
        last_monitor: resolve_monitor(PlacementHint {
            pid,
            last_monitor: None,
        }),
    }
}

/// Never returns an error to the caller. Overlay failures must not roll back a
/// successful clip save. If the overlay setting is on and showing fails, fall
/// back to an OS toast. If the user turned the overlay off, show nothing.
pub fn notify_clip_saved(app: &AppHandle, hint: PlacementHint, duration_seconds: Option<u32>) {
    show(
        app,
        OverlayNotification::ClipSaved { duration_seconds },
        hint,
    );
}

pub fn show(app: &AppHandle, notification: OverlayNotification, hint: PlacementHint) {
    if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(|| {
        show_unguarded(app, notification, hint);
    })) {
        tracing::error!("clip overlay panicked: {panic:?}");
    }
}

fn show_unguarded(app: &AppHandle, notification: OverlayNotification, hint: PlacementHint) {
    if !overlay_enabled(app) {
        return;
    }
    if let Err(err) = show_inner(app, &notification, hint) {
        tracing::warn!("clip overlay failed ({err}); falling back to OS toast");
        fallback_os_toast(app, &notification);
    }
}

fn overlay_payload(notification: &OverlayNotification, token: u64) -> OverlayShowPayload {
    match notification {
        OverlayNotification::ClipSaved { duration_seconds } => OverlayShowPayload {
            kind: OverlayKind::ClipSaved,
            duration_seconds: *duration_seconds,
            generation: token,
        },
    }
}

fn overlay_enabled(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::database::AppState>() else {
        return true;
    };
    let Ok(conn) = state.db.lock() else {
        return true;
    };
    crate::settings::load(&conn)
        .map(|settings| settings.clip_saved_notification)
        .unwrap_or(true)
}

fn show_inner(
    app: &AppHandle,
    notification: &OverlayNotification,
    hint: PlacementHint,
) -> Result<(), String> {
    let started = Instant::now();
    let monitor = resolve_monitor(hint).ok_or_else(|| "no monitor available".to_string())?;
    let token = next_generation(app);
    let payload = overlay_payload(notification, token);

    #[cfg(windows)]
    windows_impl::show_overlay(app, monitor, payload)?;
    #[cfg(not(windows))]
    {
        let _ = (app, monitor, payload, started);
        return Err("overlay is Windows-only".into());
    }

    #[cfg(windows)]
    {
        schedule_hide(app.clone(), token);
        tracing::info!(
            "clip overlay shown in {} ms (generation {token})",
            started.elapsed().as_millis()
        );
        Ok(())
    }
}

fn next_generation(app: &AppHandle) -> u64 {
    app.try_state::<OverlayManager>()
        .map(|manager| manager.generation.fetch_add(1, Ordering::SeqCst) + 1)
        .unwrap_or(1)
}

fn current_generation(app: &AppHandle) -> u64 {
    app.try_state::<OverlayManager>()
        .map(|manager| manager.generation.load(Ordering::SeqCst))
        .unwrap_or(0)
}

pub fn is_current_generation(current: u64, token: u64) -> bool {
    current == token
}

#[cfg_attr(not(windows), allow(dead_code))]
fn schedule_hide(app: AppHandle, token: u64) {
    let _ = std::thread::Builder::new()
        .name("overlay-hide".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(VISIBLE_MS));
            if !is_current_generation(current_generation(&app), token) {
                return;
            }
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.emit("overlay-hide", ());
            }
            std::thread::sleep(Duration::from_millis(FADE_MS));
            if !is_current_generation(current_generation(&app), token) {
                return;
            }
            #[cfg(windows)]
            windows_impl::hide_overlay(&app);
            #[cfg(not(windows))]
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.hide();
            }
        });
}

fn fallback_os_toast(app: &AppHandle, notification: &OverlayNotification) {
    #[cfg(windows)]
    {
        use tauri_plugin_notification::NotificationExt;
        match notification {
            OverlayNotification::ClipSaved { duration_seconds } => {
                let mut builder = app.notification().builder().title("Clip saved");
                if let Some(seconds) = duration_seconds {
                    builder = builder.body(format!("Last {seconds} seconds"));
                }
                let _ = builder.show();
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, notification);
    }
}

pub fn overlay_physical_px(logical: f64, dpi: u32) -> i32 {
    let dpi = dpi.max(96);
    ((logical * f64::from(dpi)) / 96.0).round() as i32
}

pub fn overlay_origin(monitor: MonitorInfo, width: i32, height: i32, margin: i32) -> (i32, i32) {
    let _ = height;
    let x = monitor.x + monitor.width as i32 - width - margin;
    let y = monitor.y + margin;
    (x, y)
}

fn resolve_monitor(hint: PlacementHint) -> Option<MonitorInfo> {
    #[cfg(windows)]
    {
        if let Some(pid) = hint.pid {
            if let Some(live) = windows_impl::monitor_from_pid(pid) {
                return Some(live);
            }
        }
        if let Some(last) = hint.last_monitor {
            if let Some(live) = windows_impl::monitor_containing_point(
                last.x + last.width as i32 / 2,
                last.y + last.height as i32 / 2,
            ) {
                return Some(live);
            }
        }
        windows_impl::primary_monitor()
    }
    #[cfg(not(windows))]
    {
        hint.last_monitor.or(Some(MonitorInfo {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }))
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use tauri::WebviewWindow;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HMONITOR, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::HiDpi::{
        GetDpiForMonitor, GetProcessDpiAwareness, MDT_EFFECTIVE_DPI, PROCESS_PER_MONITOR_DPI_AWARE,
        PROCESS_SYSTEM_DPI_AWARE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SWP_SHOWWINDOW, WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    struct PidEnum {
        pid: u32,
        best: HWND,
        best_area: i64,
    }

    pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
        let window = if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
            existing
        } else {
            create_window(app)?
        };
        apply_native_styles(&window)?;
        Ok(window)
    }

    fn create_window(app: &AppHandle) -> Result<WebviewWindow, String> {
        tauri::WebviewWindowBuilder::new(
            app,
            OVERLAY_LABEL,
            tauri::WebviewUrl::App("overlay.html".into()),
        )
        .title("Replayr Overlay")
        .inner_size(OVERLAY_WIDTH_LOGICAL, OVERLAY_HEIGHT_LOGICAL)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .background_color((0, 0, 0, 0).into())
        .build()
        .map_err(|err| err.to_string())
    }

    pub fn show_overlay(
        app: &AppHandle,
        monitor: MonitorInfo,
        payload: OverlayShowPayload,
    ) -> Result<(), String> {
        let window = ensure_window(app)?;
        let hwnd = overlay_hwnd(&window)?;
        let awareness = process_dpi_awareness();
        let dpi = monitor_dpi_for_rect(monitor).unwrap_or(dpi_for_awareness(awareness));
        let (width, height, margin) = overlay_pixel_metrics(awareness, dpi);
        let (x, y) = overlay_origin(monitor, width, height, margin);

        tracing::info!(
            ?awareness,
            dpi,
            monitor_x = monitor.x,
            monitor_y = monitor.y,
            monitor_w = monitor.width,
            monitor_h = monitor.height,
            x,
            y,
            width,
            height,
            "clip overlay coordinate space"
        );

        apply_native_styles(&window)?;
        unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|err| err.to_string())?;
        }

        window
            .emit("overlay-show", payload)
            .map_err(|err| err.to_string())?;
        let _ = window.set_ignore_cursor_events(true);
        Ok(())
    }

    pub fn hide_overlay(app: &AppHandle) {
        let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
            return;
        };
        if let Ok(hwnd) = overlay_hwnd(&window) {
            let _ = unsafe {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW | SWP_NOZORDER,
                )
            };
        } else {
            let _ = window.hide();
        }
    }

    fn overlay_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
        window.hwnd().map_err(|err| err.to_string())
    }

    fn apply_native_styles(window: &WebviewWindow) -> Result<(), String> {
        let _ = window.set_always_on_top(true);
        let _ = window.set_skip_taskbar(true);
        let _ = window.set_ignore_cursor_events(true);
        let hwnd = overlay_hwnd(window)?;
        let added =
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT;
        unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next = current | added.0 as isize;
            if next != current {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );
        }
        if APPLY_CAPTURE_EXCLUSION {
            match unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
                Ok(()) => {}
                Err(err) => {
                    tracing::warn!(
                        "WDA_EXCLUDEFROMCAPTURE unavailable ({err}); overlay may appear in monitor capture"
                    );
                }
            }
        }
        Ok(())
    }

    pub fn monitor_from_pid(pid: u32) -> Option<MonitorInfo> {
        let hwnd = largest_window_for_pid(pid)?;
        monitor_from_hwnd(hwnd)
    }

    pub fn monitor_containing_point(x: i32, y: i32) -> Option<MonitorInfo> {
        let handle = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
        monitor_from_hmonitor(handle)
    }

    pub fn primary_monitor() -> Option<MonitorInfo> {
        let handle = unsafe { MonitorFromWindow(HWND::default(), MONITOR_DEFAULTTOPRIMARY) };
        monitor_from_hmonitor(handle)
    }

    fn monitor_from_hwnd(hwnd: HWND) -> Option<MonitorInfo> {
        if hwnd.is_invalid() {
            return None;
        }
        let handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        monitor_from_hmonitor(handle)
    }

    fn monitor_from_hmonitor(handle: HMONITOR) -> Option<MonitorInfo> {
        if handle.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(handle, &mut info) }.as_bool() {
            return None;
        }
        let rect = info.rcMonitor;
        let width = rect.right.saturating_sub(rect.left);
        let height = rect.bottom.saturating_sub(rect.top);
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(MonitorInfo {
            x: rect.left,
            y: rect.top,
            width: width as u32,
            height: height as u32,
        })
    }

    fn largest_window_for_pid(pid: u32) -> Option<HWND> {
        let mut state = PidEnum {
            pid,
            best: HWND::default(),
            best_area: 0,
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_pid_windows),
                LPARAM(&mut state as *mut _ as isize),
            );
        }
        if state.best.is_invalid() {
            None
        } else {
            Some(state.best)
        }
    }

    unsafe extern "system" fn enum_pid_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = unsafe { &mut *(lparam.0 as *mut PidEnum) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return BOOL::from(true);
        }
        let mut window_pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut window_pid)) };
        if window_pid != state.pid {
            return BOOL::from(true);
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            return BOOL::from(true);
        }
        let area = i64::from(rect.right.saturating_sub(rect.left))
            * i64::from(rect.bottom.saturating_sub(rect.top));
        if area > state.best_area {
            state.best_area = area;
            state.best = hwnd;
        }
        BOOL::from(true)
    }

    fn process_dpi_awareness() -> DpiAwareness {
        match unsafe { GetProcessDpiAwareness(None) } {
            Ok(value) if value == PROCESS_PER_MONITOR_DPI_AWARE => DpiAwareness::PerMonitor,
            Ok(value) if value == PROCESS_SYSTEM_DPI_AWARE => DpiAwareness::System,
            Ok(_) => DpiAwareness::Unaware,
            Err(_) => DpiAwareness::PerMonitor,
        }
    }

    fn dpi_for_awareness(awareness: DpiAwareness) -> u32 {
        match awareness {
            DpiAwareness::Unaware => 96,
            DpiAwareness::System | DpiAwareness::PerMonitor => 96,
        }
    }

    fn overlay_pixel_metrics(awareness: DpiAwareness, dpi: u32) -> (i32, i32, i32) {
        let dpi = match awareness {
            DpiAwareness::Unaware => 96,
            DpiAwareness::System | DpiAwareness::PerMonitor => dpi,
        };
        (
            overlay_physical_px(OVERLAY_WIDTH_LOGICAL, dpi),
            overlay_physical_px(OVERLAY_HEIGHT_LOGICAL, dpi),
            overlay_physical_px(OVERLAY_MARGIN_LOGICAL, dpi),
        )
    }

    fn monitor_dpi_for_rect(monitor: MonitorInfo) -> Option<u32> {
        let handle = unsafe {
            MonitorFromPoint(
                POINT {
                    x: monitor.x + monitor.width as i32 / 2,
                    y: monitor.y + monitor.height as i32 / 2,
                },
                MONITOR_DEFAULTTONEAREST,
            )
        };
        if handle.is_invalid() {
            return None;
        }
        let mut dpi_x = 0u32;
        let mut dpi_y = 0u32;
        unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) }.ok()?;
        Some(dpi_x.max(dpi_y).max(96))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_origin_top_right_primary() {
        let monitor = MonitorInfo {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let (x, y) = overlay_origin(monitor, 320, 78, 24);
        assert_eq!((x, y), (1576, 24));
    }

    #[test]
    fn overlay_origin_supports_negative_virtual_desktop() {
        let monitor = MonitorInfo {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let (x, y) = overlay_origin(monitor, 320, 78, 24);
        assert_eq!((x, y), (-344, 24));
    }

    #[test]
    fn overlay_origin_secondary_monitor_positive_offset() {
        let monitor = MonitorInfo {
            x: 2560,
            y: -200,
            width: 1920,
            height: 1080,
        };
        let (x, y) = overlay_origin(monitor, 320, 78, 24);
        assert_eq!((x, y), (4136, -176));
    }

    #[test]
    fn physical_size_at_common_windows_scales() {
        assert_eq!(overlay_physical_px(320.0, 96), 320);
        assert_eq!(overlay_physical_px(78.0, 96), 78);
        assert_eq!(overlay_physical_px(24.0, 96), 24);

        assert_eq!(overlay_physical_px(320.0, 120), 400);
        assert_eq!(overlay_physical_px(78.0, 120), 98);
        assert_eq!(overlay_physical_px(24.0, 120), 30);

        assert_eq!(overlay_physical_px(320.0, 144), 480);
        assert_eq!(overlay_physical_px(78.0, 144), 117);
        assert_eq!(overlay_physical_px(24.0, 144), 36);
    }

    #[test]
    fn origin_at_150_percent_uses_physical_metrics() {
        let monitor = MonitorInfo {
            x: 0,
            y: 0,
            width: 2880,
            height: 1800,
        };
        let width = overlay_physical_px(OVERLAY_WIDTH_LOGICAL, 144);
        let height = overlay_physical_px(OVERLAY_HEIGHT_LOGICAL, 144);
        let margin = overlay_physical_px(OVERLAY_MARGIN_LOGICAL, 144);
        let (x, y) = overlay_origin(monitor, width, height, margin);
        assert_eq!((width, height, margin), (480, 117, 36));
        assert_eq!((x, y), (2364, 36));
    }

    #[test]
    fn stale_generation_does_not_hide_newer_notification() {
        assert!(is_current_generation(2, 2));
        assert!(!is_current_generation(2, 1));
        assert!(!is_current_generation(3, 2));
    }

    #[test]
    fn hint_from_pid_preserves_pid() {
        let hint = hint_from_pid(Some(4242));
        assert_eq!(hint.pid, Some(4242));
    }
}
