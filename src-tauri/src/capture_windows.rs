//! Window list and matching for composed capture.
//!
//! A window is chosen again at capture time from its title, executable, and
//! class. An HWND from the frontend is never trusted: it goes stale, and a
//! caller must not be able to point capture at an arbitrary handle.

use serde::Serialize;

const MAX_TEXT: usize = 240;
const MAX_LIST: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedWindow {
    pub title: String,
    pub class_name: String,
    pub exe: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowTarget {
    pub title: String,
    pub class_name: String,
    pub exe: String,
}

impl WindowTarget {
    pub fn is_empty(&self) -> bool {
        self.title.is_empty() && self.class_name.is_empty() && self.exe.is_empty()
    }
}

/// A window the matcher can see. Enumeration fills this; tests build it directly.
#[derive(Debug, Clone)]
pub struct WindowCandidate {
    pub title: String,
    pub class_name: String,
    pub exe: String,
    pub area: u32,
}

pub fn sanitize_target(title: &str, class_name: &str, exe: &str) -> WindowTarget {
    WindowTarget {
        title: clean_text(title),
        class_name: clean_text(class_name),
        exe: clean_exe(exe),
    }
}

/// OBS stores `title:class:exe`, with `:` encoded as `#3A` and `#` as `#22`.
pub fn parse_obs_window(raw: &str) -> WindowTarget {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 {
        return WindowTarget::default();
    }
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() < 3 {
        return sanitize_target(trimmed, "", "");
    }
    let exe = decode_obs(parts[parts.len() - 1]);
    let class_name = decode_obs(parts[parts.len() - 2]);
    let title = decode_obs(&parts[..parts.len() - 2].join(":"));
    sanitize_target(&title, &class_name, &exe)
}

/// Title wins, then the executable, then the class. A fuller match beats a
/// weaker one. Equal scores keep the larger window.
pub fn match_window<'a>(windows: &'a [WindowCandidate], target: &WindowTarget) -> Option<&'a WindowCandidate> {
    if target.is_empty() {
        return None;
    }
    let mut best: Option<(i32, &WindowCandidate)> = None;
    for window in windows {
        let score = match_score(window, target);
        if score <= 0 {
            continue;
        }
        let replace = match best {
            None => true,
            Some((best_score, best_window)) => score > best_score || (score == best_score && window.area > best_window.area),
        };
        if replace {
            best = Some((score, window));
        }
    }
    best.map(|(_, window)| window)
}

fn match_score(window: &WindowCandidate, target: &WindowTarget) -> i32 {
    let mut score = 0;
    if !target.title.is_empty() && eq_text(&window.title, &target.title) {
        score += 100;
    }
    if !target.exe.is_empty() && eq_text(&window.exe, &target.exe) {
        score += 10;
    }
    if !target.class_name.is_empty() && eq_text(&window.class_name, &target.class_name) {
        score += 1;
    }
    score
}

fn eq_text(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn decode_obs(value: &str) -> String {
    value.replace("#3A", ":").replace("#22", "#")
}

fn clean_text(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_control()).take(MAX_TEXT).collect::<String>().trim().to_string()
}

fn clean_exe(value: &str) -> String {
    let text = clean_text(value);
    text.rsplit(['\\', '/']).next().unwrap_or(&text).to_string()
}

pub fn list_capture_windows() -> Vec<ListedWindow> {
    #[cfg(windows)]
    {
        windows_impl::list_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
pub fn resolve_capture_window(target: &WindowTarget) -> Result<windows_capture::window::Window, String> {
    if target.is_empty() {
        return Err("Choose a window to record.".into());
    }
    windows_impl::resolve(target).ok_or_else(|| "That window is not open.".to_string())
}

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::{HWND, MAX_PATH};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };
    use windows_capture::window::Window;

    use super::{clean_exe, clean_text, match_window, ListedWindow, WindowCandidate, WindowTarget, MAX_LIST};

    pub fn list_windows() -> Vec<ListedWindow> {
        enumerate()
            .into_iter()
            .take(MAX_LIST)
            .map(|(_, info)| ListedWindow {
                title: info.title,
                class_name: info.class_name,
                exe: info.exe,
            })
            .collect()
    }

    pub fn resolve(target: &WindowTarget) -> Option<Window> {
        let found = enumerate();
        let candidates: Vec<WindowCandidate> = found.iter().map(|(_, info)| info.clone()).collect();
        let chosen = match_window(&candidates, target)?;
        found.into_iter().find(|(_, info)| {
            info.title == chosen.title && info.class_name == chosen.class_name && info.exe == chosen.exe && info.area == chosen.area
        }).map(|(window, _)| window)
    }

    fn enumerate() -> Vec<(Window, WindowCandidate)> {
        let Ok(windows) = Window::enumerate() else {
            return Vec::new();
        };
        let own = unsafe { GetCurrentProcessId() };
        let mut listed = Vec::new();
        for window in windows {
            let Some(info) = describe(&window, own) else {
                continue;
            };
            listed.push((window, info));
        }
        listed
    }

    fn describe(window: &Window, own_pid: u32) -> Option<WindowCandidate> {
        if !window.is_valid() {
            return None;
        }
        let hwnd = HWND(window.as_raw_hwnd());
        if cloaked(hwnd) || tool_window(hwnd) {
            return None;
        }
        let pid = window.process_id().ok()?;
        if pid == 0 || pid == own_pid {
            return None;
        }
        let width = window.width().unwrap_or(0).max(0) as u32;
        let height = window.height().unwrap_or(0).max(0) as u32;
        let area = width.saturating_mul(height);
        if area == 0 {
            return None;
        }
        let title = clean_text(&window.title().unwrap_or_default());
        let class_name = class_name(hwnd);
        let exe = clean_exe(&window.process_name().unwrap_or_default());
        if title.is_empty() && class_name.is_empty() {
            return None;
        }
        Some(WindowCandidate {
            title,
            class_name,
            exe,
            area,
        })
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buffer = [0u16; MAX_PATH as usize];
        let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
        if len <= 0 {
            return String::new();
        }
        clean_text(&String::from_utf16_lossy(&buffer[..len as usize]))
    }

    fn cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let status = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                core::mem::size_of::<u32>() as u32,
            )
        };
        status.is_ok() && cloaked != 0
    }

    fn tool_window(hwnd: HWND) -> bool {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        style & WS_EX_TOOLWINDOW.0 != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(title: &str, class_name: &str, exe: &str, area: u32) -> WindowCandidate {
        WindowCandidate {
            title: title.into(),
            class_name: class_name.into(),
            exe: exe.into(),
            area,
        }
    }

    #[test]
    fn obs_window_string_decodes_colons() {
        let parsed = parse_obs_window("Notepad#3A notes:Notepad:notepad.exe");
        assert_eq!(parsed.title, "Notepad: notes");
        assert_eq!(parsed.class_name, "Notepad");
        assert_eq!(parsed.exe, "notepad.exe");
    }

    #[test]
    fn obs_window_string_keeps_a_path_out_of_the_exe() {
        let parsed = parse_obs_window(r"Game:UnityWndClass:C:\Games\game.exe");
        assert_eq!(parsed.exe, "game.exe");
    }

    #[test]
    fn title_beats_exe_and_a_larger_tie_wins() {
        let windows = vec![
            window("Other", "Notepad", "notepad.exe", 500),
            window("Notes", "Notepad", "notepad.exe", 100),
            window("Notes", "Notepad", "notepad.exe", 400),
        ];
        let target = sanitize_target("Notes", "Notepad", "notepad.exe");
        let chosen = match_window(&windows, &target).unwrap();
        assert_eq!(chosen.area, 400);
    }

    #[test]
    fn exe_matches_when_the_title_changed() {
        let windows = vec![window("Untitled - Notepad", "Notepad", "notepad.exe", 10)];
        let target = sanitize_target("Notes", "Notepad", "notepad.exe");
        assert_eq!(match_window(&windows, &target).unwrap().title, "Untitled - Notepad");
    }

    #[test]
    fn class_is_the_last_resort() {
        let windows = vec![window("Something", "Notepad", "other.exe", 10)];
        let target = sanitize_target("Notes", "Notepad", "notepad.exe");
        assert_eq!(match_window(&windows, &target).unwrap().class_name, "Notepad");
    }

    #[test]
    fn empty_and_hostile_targets_match_nothing() {
        let windows = vec![window("Notes", "Notepad", "notepad.exe", 10)];
        assert!(match_window(&windows, &WindowTarget::default()).is_none());
        let hostile = sanitize_target("Notes\u{0000}\n", "class", "..\\..\\evil.exe");
        assert_eq!(hostile.title, "Notes");
        assert_eq!(hostile.exe, "evil.exe");
    }
}
