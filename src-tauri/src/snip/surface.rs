//! The native selection surface: one borderless, topmost window per monitor showing that monitor's
//! frozen image, dimmed, with the dragged region shown at full brightness.
//!
//! Native Win32 rather than a webview, deliberately:
//! - a window costs ~1 ms to create, so there is no pool to keep warm and nothing resident;
//! - frozen pixels never leave process memory — no custom URL scheme serving screen contents;
//! - there is no devicePixelRatio rounding: under Per-Monitor-V2 client coordinates *are* physical
//!   pixels, so crops stay exact at 125% and 175% scaling.
//!
//! Every window lives on the calling thread, which owns the message loop for the duration of one
//! snip and tears everything down before returning.

#![cfg(windows)]

use std::cell::RefCell;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, InvalidateRect,
    SelectObject, SetBkMode, SetStretchBltMode, SetTextColor, StretchBlt, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, COLORONCOLOR, DEFAULT_CHARSET,
    DEFAULT_PITCH, DIB_RGB_COLORS, DRAW_TEXT_FORMAT, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
    FW_SEMIBOLD, HBITMAP, HBRUSH, HDC, HFONT, HGDIOBJ, OUT_TT_PRECIS, PAINTSTRUCT, SRCCOPY,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SendInput, SetCapture, SetFocus, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_ESCAPE, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
    GetForegroundWindow, GetMessageW, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassExW,
    SetForegroundWindow, SetTimer, SetWindowDisplayAffinity, SetWindowPos, TranslateMessage,
    HWND_TOPMOST, IDC_CROSS, MSG, SWP_SHOWWINDOW, WDA_EXCLUDEFROMCAPTURE, WM_ACTIVATE,
    WM_ACTIVATEAPP, WM_CLOSE, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_ERASEBKGND, WM_KEYDOWN,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use zeroize::Zeroize;

use crate::still::StillFrame;

use super::crop::crop_slice;
use super::freeze::FrozenMonitor;
use super::geometry::{self, clamp_point, normalize_drag, PhysRect, Point};

const CLASS_NAME: PCWSTR = w!("ReplayrSnipSurface");
const IDLE_TIMER_ID: usize = 1;
/// A forgotten snip must never leave topmost windows covering the desktop.
const IDLE_CANCEL_AFTER: Duration = Duration::from_secs(120);
/// How far the frozen image is dimmed outside the selection, out of 256.
const DIM_LEVEL: u32 = 110;
/// Tap Alt if Windows refuses to hand us the foreground. Needed on some setups when a game holds
/// focus; harmless elsewhere. Flip off if it ever misbehaves.
const ALT_TAP_FOREGROUND_FALLBACK: bool = true;

const BORDER_COLOR: COLORREF = COLORREF(0x00FF_8C3B); // #3B8CFF
const LABEL_BG: COLORREF = COLORREF(0x0018_1410); // #101418
const LABEL_TEXT: COLORREF = COLORREF(0x00FF_FFFF);
const HINT_TEXT: &str = "Drag to take a screenshot  ·  Esc to cancel";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    Escape,
    RightClick,
    FocusLost,
    DisplayChanged,
    Idle,
    Closed,
}

pub enum Outcome {
    Commit {
        /// The selected pixels at the captured frame's native resolution.
        image: StillFrame,
        /// Desktop rect of the monitor the selection was made on, for placing the confirmation.
        monitor_rect: PhysRect,
    },
    Cancel(CancelReason),
}

/// Show the surface over every frozen monitor and block until the user commits or cancels.
///
/// Takes ownership of the frozen frames: each is copied into display bitmaps and then dropped
/// (which wipes it) before the first paint, so at most two copies of the screen exist at once.
pub fn run(monitors: Vec<FrozenMonitor>) -> Result<Outcome, String> {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    register_class()?;
    let previous_foreground = unsafe { GetForegroundWindow() };

    let mut displays = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        // `monitor` is dropped (and its pixels zeroed) at the end of each iteration.
        displays.push(Display::build(&monitor)?);
    }

    let session = Session::new(displays)?;
    SESSION.with(|cell| *cell.borrow_mut() = Some(session));
    let teardown = Teardown { previous_foreground };

    let hwnds = create_windows()?;
    focus_initial(&hwnds);

    let mut msg = MSG::default();
    loop {
        let status = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if status.0 == 0 || status.0 == -1 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    let outcome = SESSION.with(|cell| cell.borrow_mut().as_mut().and_then(|session| session.outcome.take()));
    drop(teardown);
    Ok(outcome.unwrap_or(Outcome::Cancel(CancelReason::Closed)))
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Destroys every window and GDI object on every exit path, then gives focus back.
struct Teardown {
    previous_foreground: HWND,
}

impl Drop for Teardown {
    fn drop(&mut self) {
        // Take the session out first: DestroyWindow re-enters the window procedure synchronously,
        // and it must find no session rather than a borrowed one.
        let session = SESSION.with(|cell| cell.borrow_mut().take());
        if let Some(session) = session {
            for display in &session.displays {
                if !display.hwnd.is_invalid() {
                    unsafe {
                        let _ = KillTimer(Some(display.hwnd), IDLE_TIMER_ID);
                        let _ = DestroyWindow(display.hwnd);
                    }
                }
            }
            drop(session);
        }
        if !self.previous_foreground.is_invalid() {
            // Hand focus back to the game or app the user was in, rather than whatever Windows
            // picks next in z-order.
            unsafe {
                let _ = SetForegroundWindow(self.previous_foreground);
            }
        }
    }
}

/// A GDI DIB section selected into its own memory DC. Pixels are zeroed before release.
struct DibSection {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: u32,
    height: u32,
}

impl DibSection {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "The screen is too large to display.".to_string())?;
        if len == 0 {
            return Err("The screen has no pixels.".into());
        }
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err("Could not create a drawing surface.".into());
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    // Negative height: top-down, so row 0 is the top row, matching the frame.
                    biHeight: -(height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bitmap) if !bits.is_null() => bitmap,
                Ok(bitmap) => {
                    let _ = DeleteObject(bitmap.into());
                    let _ = DeleteDC(dc);
                    return Err("Could not allocate the screen image.".into());
                }
                Err(err) => {
                    let _ = DeleteDC(dc);
                    return Err(format!("Could not allocate the screen image: {err}"));
                }
            };
            let previous = SelectObject(dc, bitmap.into());
            Ok(Self { dc, bitmap, previous, bits: bits.cast::<u8>(), width, height })
        }
    }

    fn len(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }

    fn pixels(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.bits, self.len()) }
    }

    fn pixels_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, self.len()) }
    }
}

impl Drop for DibSection {
    fn drop(&mut self) {
        self.pixels_mut().zeroize();
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

struct Display {
    hwnd: HWND,
    /// Physical desktop rect of the monitor; also the window's size.
    rect: PhysRect,
    dpi: u32,
    /// Frozen image at native frame resolution.
    bright: DibSection,
    dim: DibSection,
}

impl Display {
    fn build(monitor: &FrozenMonitor) -> Result<Self, String> {
        let frame = &monitor.frame;
        let mut bright = DibSection::new(frame.width, frame.height)?;
        let mut dim = DibSection::new(frame.width, frame.height)?;
        let row_bytes = frame.width as usize * 4;
        let pitch = (frame.pitch as usize).max(row_bytes);
        if frame.bgra.len() < pitch * (frame.height as usize - 1) + row_bytes {
            return Err("The captured screen was incomplete.".into());
        }
        {
            let bright_px = bright.pixels_mut();
            for row in 0..frame.height as usize {
                let src = &frame.bgra[row * pitch..row * pitch + row_bytes];
                bright_px[row * row_bytes..(row + 1) * row_bytes].copy_from_slice(src);
            }
        }
        {
            let (bright_px, dim_px) = (bright.pixels(), dim.pixels_mut());
            for (src, dst) in bright_px.chunks_exact(4).zip(dim_px.chunks_exact_mut(4)) {
                dst[0] = ((src[0] as u32 * DIM_LEVEL) >> 8) as u8;
                dst[1] = ((src[1] as u32 * DIM_LEVEL) >> 8) as u8;
                dst[2] = ((src[2] as u32 * DIM_LEVEL) >> 8) as u8;
                dst[3] = 0xFF;
            }
        }
        Ok(Self { hwnd: HWND::default(), rect: monitor.rect, dpi: monitor.dpi, bright, dim })
    }

    fn client_size(&self) -> (u32, u32) {
        (self.rect.w, self.rect.h)
    }

    fn scale(&self, value: u32) -> u32 {
        (value * self.dpi).div_ceil(96).max(1)
    }
}

struct Drag {
    display: usize,
    anchor: Point,
    current: Point,
}

struct Session {
    displays: Vec<Display>,
    drag: Option<Drag>,
    outcome: Option<Outcome>,
    active: bool,
    last_input: Instant,
    font: HFONT,
    border_brush: HBRUSH,
    label_brush: HBRUSH,
}

impl Session {
    fn new(displays: Vec<Display>) -> Result<Self, String> {
        let largest_dpi = displays.iter().map(|display| display.dpi).max().unwrap_or(96);
        let font_px = (13 * largest_dpi).div_ceil(96) as i32;
        unsafe {
            let font = CreateFontW(
                -font_px,
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_TT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                DEFAULT_PITCH.0 as u32,
                w!("Segoe UI"),
            );
            Ok(Self {
                displays,
                drag: None,
                outcome: None,
                active: false,
                last_input: Instant::now(),
                font,
                border_brush: CreateSolidBrush(BORDER_COLOR),
                label_brush: CreateSolidBrush(LABEL_BG),
            })
        }
    }

    fn index_of(&self, hwnd: HWND) -> Option<usize> {
        self.displays.iter().position(|display| display.hwnd == hwnd)
    }

    fn selection(&self) -> Option<(usize, PhysRect)> {
        let drag = self.drag.as_ref()?;
        Some((drag.display, normalize_drag(drag.anchor, drag.current)))
    }

    fn cancel(&mut self, reason: CancelReason, after: &mut Vec<After>) {
        if self.outcome.is_none() {
            self.outcome = Some(Outcome::Cancel(reason));
            after.push(After::Quit);
        }
    }

    /// Everything a repaint for this selection could touch: the bright region and its border,
    /// plus the size label and the hint.
    fn dirty_area(&self, display: &Display, selection: Option<PhysRect>) -> PhysRect {
        let mut area = hint_rect(display);
        if let Some(rect) = selection {
            let border = display.scale(2);
            area = area.union(rect.inflate(border)).union(label_rect(display, rect));
        }
        area
    }

    fn handle(&mut self, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<(LRESULT, Vec<After>)> {
        let mut after = Vec::new();
        let index = self.index_of(hwnd)?;
        match msg {
            WM_LBUTTONDOWN => {
                self.last_input = Instant::now();
                if self.drag.is_none() {
                    let point = client_point(lparam);
                    let (w, h) = self.displays[index].client_size();
                    let point = clamp_point(point, w, h);
                    self.drag = Some(Drag { display: index, anchor: point, current: point });
                    let dirty = self.dirty_area(&self.displays[index], self.selection().map(|(_, r)| r));
                    after.push(After::Capture(hwnd));
                    after.push(After::Invalidate(hwnd, dirty));
                }
                Some((LRESULT(0), after))
            }
            WM_MOUSEMOVE => {
                self.last_input = Instant::now();
                if let Some(drag) = self.drag.as_ref() {
                    if drag.display == index {
                        let before = self.selection().map(|(_, rect)| rect);
                        let (w, h) = self.displays[index].client_size();
                        let point = clamp_point(client_point(lparam), w, h);
                        if let Some(drag) = self.drag.as_mut() {
                            drag.current = point;
                        }
                        let now = self.selection().map(|(_, rect)| rect);
                        let display = &self.displays[index];
                        let dirty = self.dirty_area(display, before).union(self.dirty_area(display, now));
                        after.push(After::Invalidate(hwnd, dirty));
                    }
                }
                Some((LRESULT(0), after))
            }
            WM_LBUTTONUP => {
                self.last_input = Instant::now();
                let Some((display_index, rect)) = self.selection() else {
                    return Some((LRESULT(0), after));
                };
                after.push(After::Release);
                if !geometry::is_usable(rect) {
                    // A click, not a drag: keep the surface up and let the user try again.
                    let display = &self.displays[display_index];
                    let dirty = self.dirty_area(display, Some(rect));
                    self.drag = None;
                    after.push(After::Invalidate(display.hwnd, dirty));
                    return Some((LRESULT(0), after));
                }
                let display = &self.displays[display_index];
                let (client_w, client_h) = display.client_size();
                let frame_rect =
                    geometry::client_to_frame(rect, client_w, client_h, display.bright.width, display.bright.height);
                match crop_slice(
                    display.bright.pixels(),
                    display.bright.width,
                    display.bright.height,
                    display.bright.width * 4,
                    frame_rect,
                ) {
                    Ok(image) => {
                        self.outcome = Some(Outcome::Commit { image, monitor_rect: display.rect });
                        after.push(After::Quit);
                    }
                    Err(err) => {
                        tracing::warn!(%err, "screenshot crop failed");
                        self.cancel(CancelReason::Closed, &mut after);
                    }
                }
                Some((LRESULT(0), after))
            }
            WM_RBUTTONUP => {
                self.cancel(CancelReason::RightClick, &mut after);
                Some((LRESULT(0), after))
            }
            WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => {
                self.cancel(CancelReason::Escape, &mut after);
                Some((LRESULT(0), after))
            }
            WM_ACTIVATE => {
                if wparam.0 & 0xFFFF != 0 {
                    self.active = true;
                }
                Some((LRESULT(0), after))
            }
            WM_ACTIVATEAPP => {
                // Activation moved to another app (Alt-Tab, a notification, a game grabbing
                // focus). Only honour it once we actually had focus, and never for one of our
                // own surfaces taking over from another.
                let foreground = unsafe { GetForegroundWindow() };
                if wparam.0 == 0 && self.active && self.index_of(foreground).is_none() {
                    self.cancel(CancelReason::FocusLost, &mut after);
                }
                Some((LRESULT(0), after))
            }
            WM_DISPLAYCHANGE => {
                // Monitor layout changed under us: every rect is now stale.
                self.cancel(CancelReason::DisplayChanged, &mut after);
                Some((LRESULT(0), after))
            }
            WM_TIMER if wparam.0 == IDLE_TIMER_ID => {
                if self.last_input.elapsed() >= IDLE_CANCEL_AFTER {
                    self.cancel(CancelReason::Idle, &mut after);
                }
                Some((LRESULT(0), after))
            }
            WM_CLOSE => {
                self.cancel(CancelReason::Closed, &mut after);
                Some((LRESULT(0), after))
            }
            _ => None,
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.font.into());
            let _ = DeleteObject(self.border_brush.into());
            let _ = DeleteObject(self.label_brush.into());
        }
    }
}

/// Side effects deferred until the session borrow is released, because these calls send messages
/// back into the window procedure synchronously.
enum After {
    Capture(HWND),
    Release,
    Invalidate(HWND, PhysRect),
    Quit,
}

impl After {
    fn run(self) {
        unsafe {
            match self {
                After::Capture(hwnd) => {
                    SetCapture(hwnd);
                }
                After::Release => {
                    let _ = ReleaseCapture();
                }
                After::Invalidate(hwnd, rect) => {
                    let rect = to_rect(rect);
                    let _ = InvalidateRect(Some(hwnd), Some(&rect), false);
                }
                After::Quit => PostQuitMessage(0),
            }
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // The whole client area is painted from the frozen image; erasing first only flickers.
        WM_ERASEBKGND => return LRESULT(1),
        // Keep the window exactly on its monitor rather than letting Windows resize it.
        WM_DPICHANGED => return LRESULT(0),
        WM_PAINT => {
            let painted = SESSION.with(|cell| match cell.try_borrow() {
                Ok(guard) => guard.as_ref().map(|session| paint(session, hwnd)).is_some(),
                Err(_) => false,
            });
            if painted {
                return LRESULT(0);
            }
        }
        _ => {}
    }

    let handled = SESSION.with(|cell| {
        let mut guard = cell.try_borrow_mut().ok()?;
        guard.as_mut()?.handle(hwnd, msg, wparam, lparam)
    });
    match handled {
        Some((result, after)) => {
            for action in after {
                action.run();
            }
            result
        }
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn paint(session: &Session, hwnd: HWND) {
    let Some(index) = session.index_of(hwnd) else {
        return;
    };
    let display = &session.displays[index];
    let mut ps = PAINTSTRUCT::default();
    unsafe {
        let hdc = BeginPaint(hwnd, &mut ps);
        let area = ps.rcPaint;
        let (pw, ph) = (area.right - area.left, area.bottom - area.top);
        if pw > 0 && ph > 0 && !hdc.is_invalid() {
            // Compose off-screen and present once, so the dim -> bright -> border sequence never
            // flashes on screen.
            let back = CreateCompatibleDC(Some(hdc));
            let bitmap = CreateCompatibleBitmap(hdc, pw, ph);
            let previous = SelectObject(back, bitmap.into());
            SetStretchBltMode(back, COLORONCOLOR);

            let paint_rect = PhysRect { x: area.left, y: area.top, w: pw as u32, h: ph as u32 };
            blit_from(back, paint_rect, paint_rect, display, &display.dim);

            let selection = session.selection().filter(|(owner, _)| *owner == index).map(|(_, rect)| rect);
            match selection {
                Some(rect) => {
                    let visible = geometry::clamp_to(rect, paint_rect);
                    if !visible.is_empty() {
                        blit_from(back, paint_rect, visible, display, &display.bright);
                    }
                    draw_border(back, paint_rect, rect, display, session.border_brush);
                    draw_label(back, paint_rect, rect, display, session);
                }
                None if session.drag.is_none() => draw_hint(back, paint_rect, display, session),
                None => {}
            }

            let _ = BitBlt(hdc, area.left, area.top, pw, ph, Some(back), 0, 0, SRCCOPY);
            SelectObject(back, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(back);
        }
        let _ = EndPaint(hwnd, &ps);
    }
}

/// Copy `region` (client coordinates) from a display bitmap into the back buffer covering
/// `paint_rect`, scaling only if the frame and window sizes differ.
fn blit_from(back: HDC, paint_rect: PhysRect, region: PhysRect, display: &Display, source: &DibSection) {
    let (client_w, client_h) = display.client_size();
    let src = geometry::client_to_frame(region, client_w, client_h, source.width, source.height);
    if src.is_empty() {
        return;
    }
    let dx = region.x - paint_rect.x;
    let dy = region.y - paint_rect.y;
    unsafe {
        if src.w == region.w && src.h == region.h {
            let _ = BitBlt(back, dx, dy, region.w as i32, region.h as i32, Some(source.dc), src.x, src.y, SRCCOPY);
        } else {
            let _ = StretchBlt(
                back,
                dx,
                dy,
                region.w as i32,
                region.h as i32,
                Some(source.dc),
                src.x,
                src.y,
                src.w as i32,
                src.h as i32,
                SRCCOPY,
            );
        }
    }
}

fn draw_border(back: HDC, paint_rect: PhysRect, rect: PhysRect, display: &Display, brush: HBRUSH) {
    let t = display.scale(2) as i32;
    let (x, y) = (rect.x - paint_rect.x, rect.y - paint_rect.y);
    let (w, h) = (rect.w as i32, rect.h as i32);
    // Drawn just outside the selection so it never covers selected pixels.
    let edges = [
        RECT { left: x - t, top: y - t, right: x + w + t, bottom: y },
        RECT { left: x - t, top: y + h, right: x + w + t, bottom: y + h + t },
        RECT { left: x - t, top: y, right: x, bottom: y + h },
        RECT { left: x + w, top: y, right: x + w + t, bottom: y + h },
    ];
    for edge in &edges {
        unsafe {
            FillRect(back, edge, brush);
        }
    }
}

fn draw_label(back: HDC, paint_rect: PhysRect, selection: PhysRect, display: &Display, session: &Session) {
    let (client_w, client_h) = display.client_size();
    let frame = geometry::client_to_frame(selection, client_w, client_h, display.bright.width, display.bright.height);
    let text = format!("{} × {}", frame.w, frame.h);
    draw_pill(back, paint_rect, label_rect(display, selection), &text, session);
}

fn draw_hint(back: HDC, paint_rect: PhysRect, display: &Display, session: &Session) {
    draw_pill(back, paint_rect, hint_rect(display), HINT_TEXT, session);
}

fn draw_pill(back: HDC, paint_rect: PhysRect, pill: PhysRect, text: &str, session: &Session) {
    if geometry::clamp_to(pill, paint_rect).is_empty() {
        return;
    }
    let mut rect = to_rect(PhysRect { x: pill.x - paint_rect.x, y: pill.y - paint_rect.y, ..pill });
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        FillRect(back, &rect, session.label_brush);
        let previous = SelectObject(back, session.font.into());
        SetBkMode(back, TRANSPARENT);
        SetTextColor(back, LABEL_TEXT);
        DrawTextW(back, &mut wide, &mut rect, DRAW_TEXT_FORMAT(DT_CENTER.0 | DT_VCENTER.0 | DT_SINGLELINE.0));
        SelectObject(back, previous);
    }
}

/// Where the "W × H" label goes: just above the selection's top-left corner, or tucked inside it
/// when there is no room above. Fixed width so repaint areas can be computed without measuring.
fn label_rect(display: &Display, selection: PhysRect) -> PhysRect {
    let (w, h) = (display.scale(120), display.scale(24));
    let gap = display.scale(6);
    let (client_w, _) = display.client_size();
    let y = if selection.y >= (h + gap) as i32 { selection.y - (h + gap) as i32 } else { selection.y + gap as i32 };
    let max_x = client_w.saturating_sub(w) as i32;
    PhysRect { x: selection.x.clamp(0, max_x.max(0)), y: y.max(0), w, h }
}

fn hint_rect(display: &Display) -> PhysRect {
    let (w, h) = (display.scale(340), display.scale(32));
    let (client_w, _) = display.client_size();
    PhysRect { x: (client_w.saturating_sub(w) / 2) as i32, y: display.scale(28) as i32, w, h }
}

fn register_class() -> Result<(), String> {
    use std::sync::OnceLock;
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| unsafe {
            let instance = GetModuleHandleW(None).map_err(|err| err.to_string())?;
            let cursor = LoadCursorW(None, IDC_CROSS).map_err(|err| err.to_string())?;
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                hCursor: cursor,
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            if RegisterClassExW(&class) == 0 {
                return Err("Could not register the screenshot window class.".into());
            }
            Ok(())
        })
        .clone()
}

fn create_windows() -> Result<Vec<HWND>, String> {
    let geometry: Vec<PhysRect> =
        SESSION.with(|cell| cell.borrow().as_ref().map(|s| s.displays.iter().map(|d| d.rect).collect()).unwrap_or_default());
    let instance = unsafe { GetModuleHandleW(None) }.map_err(|err| err.to_string())?;
    let mut hwnds = Vec::with_capacity(geometry.len());
    for rect in geometry {
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                CLASS_NAME,
                w!("Replayr Screenshot"),
                WS_POPUP,
                rect.x,
                rect.y,
                rect.w as i32,
                rect.h as i32,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }
        .map_err(|err| format!("Could not open the screenshot surface: {err}"))?;
        // Before it is ever visible: Instant Replay and recordings must not capture the frozen
        // overlay, and a second screenshot must not capture the first one's surface.
        if let Err(err) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
            tracing::warn!(%err, "screenshot surface could not be excluded from capture");
        }
        SESSION.with(|cell| {
            if let Some(session) = cell.borrow_mut().as_mut() {
                if let Some(display) = session.displays.iter_mut().find(|d| d.hwnd.is_invalid() && d.rect == rect) {
                    display.hwnd = hwnd;
                }
            }
        });
        unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), rect.x, rect.y, rect.w as i32, rect.h as i32, SWP_SHOWWINDOW);
            let _ = SetTimer(Some(hwnd), IDLE_TIMER_ID, 1000, None);
        }
        hwnds.push(hwnd);
    }
    Ok(hwnds)
}

/// Give keyboard focus to the surface under the cursor so Esc works immediately.
fn focus_initial(hwnds: &[HWND]) {
    let mut cursor = POINT::default();
    let _ = unsafe { GetCursorPos(&mut cursor) };
    let rects: Vec<PhysRect> =
        SESSION.with(|cell| cell.borrow().as_ref().map(|s| s.displays.iter().map(|d| d.rect).collect()).unwrap_or_default());
    let target = rects
        .iter()
        .zip(hwnds)
        .find(|(rect, _)| {
            (cursor.x as i64) >= rect.x as i64
                && (cursor.x as i64) < rect.right()
                && (cursor.y as i64) >= rect.y as i64
                && (cursor.y as i64) < rect.bottom()
        })
        .map(|(_, hwnd)| *hwnd)
        .or_else(|| hwnds.first().copied());
    let Some(hwnd) = target else {
        return;
    };
    unsafe {
        let _ = SetForegroundWindow(hwnd);
        if ALT_TAP_FOREGROUND_FALLBACK && GetForegroundWindow() != hwnd {
            // Windows only allows a foreground change from the process that received the last
            // input. A synthetic Alt press satisfies that without typing anything.
            let tap = |flags: KEYBD_EVENT_FLAGS| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MENU, dwFlags: flags, ..Default::default() } },
            };
            let _ = SendInput(&[tap(KEYBD_EVENT_FLAGS(0)), tap(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32);
            let _ = SetForegroundWindow(hwnd);
        }
        let _ = SetFocus(Some(hwnd));
    }
}

fn client_point(lparam: LPARAM) -> Point {
    // GET_X_LPARAM / GET_Y_LPARAM: signed 16-bit, since captured drags can leave the window.
    Point { x: (lparam.0 & 0xFFFF) as i16 as i32, y: ((lparam.0 >> 16) & 0xFFFF) as i16 as i32 }
}

fn to_rect(rect: PhysRect) -> RECT {
    RECT {
        left: rect.x,
        top: rect.y,
        right: rect.right().clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        bottom: rect.bottom().clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    }
}
