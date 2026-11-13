//! An isolated page. It is not the app window, it has no Tauri bridge, and it
//! can only stay on the address that was opened.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use webview2_com::{
    CapturePreviewCompletedHandler, CoTaskMemPWSTR, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::*,
};
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, IStream, STREAM_SEEK_SET, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, MSG, PM_REMOVE, WINDOW_EX_STYLE, WINDOW_STYLE,
    WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::browser_policy::{navigation_allowed, sanitize_page_url};
use crate::still::StillFrame;

const PAGE_W: i32 = 960;
const PAGE_H: i32 = 540;

pub struct BrowserView {
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<StillFrame>>>,
    thread: Option<JoinHandle<()>>,
}

impl BrowserView {
    pub fn open(url: &str, folder: &str) -> Result<Self, String> {
        let url = sanitize_page_url(url)?;
        let stop = Arc::new(AtomicBool::new(false));
        let latest = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel();
        let thread_stop = Arc::clone(&stop);
        let thread_latest = Arc::clone(&latest);
        let folder = sanitize_folder(folder);
        let thread = thread::spawn(move || {
            match open_page(&url, &folder) {
                Ok(page) => {
                    let _ = tx.send(Ok(()));
                    pump(page, &thread_stop, &thread_latest);
                }
                Err(err) => {
                    tracing::warn!(error = %err, "browser source did not start");
                    let _ = tx.send(Err(err));
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { stop, latest, thread: Some(thread) }),
            Ok(Err(err)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                Err("That page could not be opened.".into())
            }
        }
    }

    pub fn latest(&self) -> Option<StillFrame> {
        self.latest.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for BrowserView {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Page {
    hwnd: HWND,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
}

struct HostWindow {
    hwnd: HWND,
    close: bool,
}

impl Drop for HostWindow {
    fn drop(&mut self) {
        if self.close {
            unsafe { let _ = DestroyWindow(self.hwnd); }
        }
    }
}

fn open_page(url: &str, folder: &str) -> Result<Page, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|err| err.to_string())?;
    }
    let mut host = HostWindow { hwnd: create_host_window()?, close: true };
    let hwnd = host.hwnd;
    let profile = profile_dir(folder)?;
    let wide = wide_path(&profile);
    let environment = {
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), PCWSTR(wide.as_ptr()), None, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error, environment| {
                error?;
                let _ = tx.send(environment.ok_or_else(|| windows::core::Error::from_win32()));
                Ok(())
            }),
        )
        .map_err(|_| "Browser sources need the WebView2 runtime.".to_string())?;
        rx.recv().map_err(|_| "Browser sources need the WebView2 runtime.".to_string())?
            .map_err(|_| "Browser sources need the WebView2 runtime.".to_string())?
    };
    let controller = {
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                environment
                    .CreateCoreWebView2Controller(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error, controller| {
                error?;
                let _ = tx.send(controller.ok_or_else(|| windows::core::Error::from_win32()));
                Ok(())
            }),
        )
        .map_err(|err| err.to_string())?;
        rx.recv().map_err(|err| err.to_string())?.map_err(|err| err.to_string())?
    };
    let webview = unsafe {
        controller.SetBounds(RECT { left: 0, top: 0, right: PAGE_W, bottom: PAGE_H }).map_err(|err| err.to_string())?;
        controller.SetIsVisible(true).map_err(|err| err.to_string())?;
        controller.CoreWebView2().map_err(|err| err.to_string())?
    };
    lock_down(&webview, url)?;
    let wide_url = wide_string(url);
    unsafe { webview.Navigate(PCWSTR(wide_url.as_ptr())).map_err(|err| err.to_string())? };
    host.close = false;
    Ok(Page { hwnd, controller, webview })
}

fn lock_down(webview: &ICoreWebView2, start: &str) -> Result<(), String> {
    unsafe {
        let settings = webview.Settings().map_err(|err| err.to_string())?;
        settings.SetAreDevToolsEnabled(false).map_err(|err| err.to_string())?;
        settings.SetAreHostObjectsAllowed(false).map_err(|err| err.to_string())?;
        settings.SetIsWebMessageEnabled(false).map_err(|err| err.to_string())?;
        settings.SetAreDefaultScriptDialogsEnabled(false).map_err(|err| err.to_string())?;
        settings.SetIsStatusBarEnabled(false).map_err(|err| err.to_string())?;
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        if let Ok(extra) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = extra.SetAreBrowserAcceleratorKeysEnabled(false);
        }
        let origin = start.to_string();
        let mut token = 0i64;
        webview
            .add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_view, args| {
                    cancel_unless_allowed(&origin, args);
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|err| err.to_string())?;
        webview
            .add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(|_view, args| {
                    if let Some(args) = args {
                        let _ = args.SetHandled(true);
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|err| err.to_string())?;
        webview
            .add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_view, args| {
                    if let Some(args) = args {
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn cancel_unless_allowed(start: &str, args: Option<ICoreWebView2NavigationStartingEventArgs>) {
    let Some(args) = args else {
        return;
    };
    let mut raw = PWSTR::null();
    let allowed = unsafe { args.Uri(&mut raw).is_ok() }
        && navigation_allowed(start, &CoTaskMemPWSTR::from(raw).to_string());
    if !allowed {
        unsafe { let _ = args.SetCancel(true); }
    }
}

fn pump(page: Page, stop: &AtomicBool, latest: &Arc<Mutex<Option<StillFrame>>>) {
    let mut next = Instant::now();
    let mut msg = MSG::default();
    while !stop.load(Ordering::SeqCst) {
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() } {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if next <= Instant::now() {
            let _ = capture(&page.webview, latest);
            next = Instant::now() + Duration::from_millis(200);
        }
        thread::sleep(Duration::from_millis(16));
    }
    unsafe {
        let _ = page.controller.Close();
        let _ = DestroyWindow(page.hwnd);
    }
}

fn capture(webview: &ICoreWebView2, latest: &Arc<Mutex<Option<StillFrame>>>) -> Result<(), String> {
    let stream = unsafe { SHCreateMemStream(None) }.ok_or_else(|| "preview".to_string())?;
    let (tx, rx) = mpsc::channel();
    let copy = stream.clone();
    unsafe {
        webview
            .CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    let _ = tx.send(result);
                    Ok(())
                })),
            )
            .map_err(|err| err.to_string())?;
    }
    let deadline = Instant::now() + Duration::from_millis(700);
    while Instant::now() < deadline {
        if let Ok(result) = rx.try_recv() {
            result.map_err(|err| err.to_string())?;
            if let Some(frame) = png_stream(&copy) {
                if let Ok(mut slot) = latest.lock() {
                    *slot = Some(frame);
                }
            }
            return Ok(());
        }
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() } {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

fn png_stream(stream: &IStream) -> Option<StillFrame> {
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let mut read = 0u32;
        let result = unsafe { stream.Read(chunk.as_mut_ptr() as *mut _, chunk.len() as u32, Some(&mut read)) };
        if result.is_err() || read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
        if bytes.len() > 8 * 1024 * 1024 {
            return None;
        }
    }
    decode_png_bgra(&bytes)
}

fn decode_png_bgra(bytes: &[u8]) -> Option<StillFrame> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let width = info.width;
    let height = info.height;
    if width < 2 || height < 2 || width > 1920 || height > 1080 {
        return None;
    }
    let src = &buf[..info.buffer_size()];
    let bgra = match info.color_type {
        png::ColorType::Rgba => src
            .chunks_exact(4)
            .flat_map(|px| [px[2], px[1], px[0], px[3]])
            .collect(),
        png::ColorType::Rgb => src
            .chunks_exact(3)
            .flat_map(|px| [px[2], px[1], px[0], 255])
            .collect(),
        _ => return None,
    };
    Some(StillFrame { bgra, width, height, pitch: width * 4 })
}

fn create_host_window() -> Result<HWND, String> {
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|err| err.to_string())?;
        let class = wide_string("ReplayrBrowserSource");
        let info = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(class.as_ptr()),
            ..WNDCLASSW::default()
        };
        let _ = RegisterClassW(&info);
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class.as_ptr()),
            PCWSTR(wide_string("Replayr").as_ptr()),
            WS_POPUP,
            -20_000,
            -20_000,
            PAGE_W,
            PAGE_H,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|err| err.to_string())?;
        Ok(hwnd)
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn profile_dir(folder: &str) -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = root.join("Replayr").join("browser-sources").join(folder);
    std::fs::create_dir_all(&dir).map_err(|_| "That page could not be opened.".to_string())?;
    Ok(dir)
}

fn sanitize_folder(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(40)
        .collect();
    if cleaned.is_empty() { "page".into() } else { cleaned }
}

fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

// Silence unused imports if a Windows style alias is unused on this SDK.
#[allow(dead_code)]
fn _styles() -> (WINDOW_EX_STYLE, WINDOW_STYLE) {
    (WS_EX_TOOLWINDOW, WS_POPUP)
}
