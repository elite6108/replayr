//! Windows Fixed Version WebView2 bootstrap for broken/ghost Evergreen installs.
//!
//! We intentionally use `webviewInstallMode: skip` and set
//! `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` ourselves. Tauri's `fixedRuntime` mode
//! sets that env var from `current_exe()` which often keeps the `\\?\` prefix,
//! and WebView2 fails to launch with that path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

const FIXED_RUNTIME_DIR_NAME: &str = "webview2-fixed";
const UI_WATCHDOG_SECS: u64 = 8;

/// Point WebView2 at the bundled Fixed Version runtime before Tauri creates windows.
pub fn configure_fixed_runtime() {
    let Some(runtime_dir) = resolve_bundled_runtime_dir() else {
        tracing::warn!(
            "bundled Fixed Version WebView2 not found next to the exe; falling back to system runtime"
        );
        return;
    };

    let runtime_dir = strip_verbatim(runtime_dir);
    let exe_path = runtime_dir.join("msedgewebview2.exe");
    if !exe_path.is_file() {
        tracing::error!(
            path = %exe_path.display(),
            "bundled WebView2 folder is missing msedgewebview2.exe"
        );
        return;
    }

    // Force a clean path every launch (do not trust a pre-set \\?\ value).
    std::env::set_var(
        "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
        runtime_dir.as_os_str(),
    );
    tracing::info!(
        path = %runtime_dir.display(),
        "using bundled Fixed Version WebView2 runtime"
    );

    if let Some(user_data) = fixed_user_data_dir() {
        let user_data = strip_verbatim(user_data);
        if let Err(err) = std::fs::create_dir_all(&user_data) {
            tracing::warn!("could not create WebView2 user data dir: {err}");
        } else {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", user_data.as_os_str());
            tracing::info!(path = %user_data.display(), "WEBVIEW2_USER_DATA_FOLDER set");
        }
    }

    // Win10 Fixed Version 120+ needs App Container read/execute on the runtime folder.
    grant_app_container_read_execute(&runtime_dir);
}

/// After startup, exit with a native error if the UI webview never comes up.
pub fn spawn_ui_watchdog(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("webview-ui-watchdog".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(UI_WATCHDOG_SECS));
            if ui_looks_alive(&app) {
                return;
            }

            let runtime_hint = std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER")
                .unwrap_or_else(|_| "(system / unset)".into());
            let runtime_path = PathBuf::from(&runtime_hint);
            let exe_path = runtime_path.join("msedgewebview2.exe");
            let exe_state = if runtime_hint == "(system / unset)" {
                "bundled runtime path unset".to_string()
            } else if exe_path.is_file() {
                format!("msedgewebview2.exe present ({})", exe_path.display())
            } else {
                format!("msedgewebview2.exe MISSING ({})", exe_path.display())
            };

            let message = format!(
                "Replayr could not start its UI.\n\n\
WebView2 did not launch.\n\
Runtime folder:\n{runtime_hint}\n\
{exe_state}\n\n\
Whitelist the whole Replayr folder (including webview2-fixed\\msedgewebview2.exe) in antivirus, then reinstall 0.1.43+."
            );
            tracing::error!("main UI webview failed to start; exiting");
            show_fatal_message(&message);
            app.exit(1);
        });
}

fn resolve_bundled_runtime_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = strip_verbatim(exe.parent()?.to_path_buf());
    let candidates = [
        exe_dir.join(FIXED_RUNTIME_DIR_NAME),
        // Dev: running from target/release or target/debug while runtime lives under src-tauri/
        exe_dir
            .join("..")
            .join("..")
            .join("..")
            .join("webview2-fixed"),
        exe_dir.join("..").join("..").join("webview2-fixed"),
    ];
    for candidate in candidates {
        let candidate = strip_verbatim(candidate);
        if candidate.join("msedgewebview2.exe").is_file() {
            return Some(candidate);
        }
    }
    None
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn fixed_user_data_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join(crate::branding::APP_IDENTIFIER)
            .join("webview"),
    )
}

fn ui_looks_alive(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return msedgewebview2_running();
    };
    if window.is_visible().unwrap_or(false) {
        return true;
    }
    // One recovery attempt in case the window was created but not shown.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(1000));
    window.is_visible().unwrap_or(false) || msedgewebview2_running()
}

fn msedgewebview2_running() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        unsafe {
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(
                        &entry.szExeFile
                            [..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                    );
                    if name.eq_ignore_ascii_case("msedgewebview2.exe") {
                        found = true;
                        break;
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        found
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn grant_app_container_read_execute(runtime_dir: &Path) {
    let path = strip_verbatim(runtime_dir.to_path_buf());
    let path = path.to_string_lossy();
    for sid in ["*S-1-15-2-1", "*S-1-15-2-2"] {
        let status = std::process::Command::new("icacls")
            .args([path.as_ref(), "/grant", &format!("{sid}:(OI)(CI)(RX)")])
            .status();
        match status {
            Ok(code) if code.success() => {}
            Ok(code) => tracing::warn!(%sid, %code, "icacls grant returned non-zero"),
            Err(err) => tracing::warn!(%sid, error = %err, "icacls grant failed"),
        }
    }
}

fn show_fatal_message(message: &str) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

        let text = HSTRING::from(message);
        let title = HSTRING::from("Replayr");
        unsafe {
            let _ = MessageBoxW(None, &text, &title, MB_OK | MB_ICONERROR);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = message;
    }
}
