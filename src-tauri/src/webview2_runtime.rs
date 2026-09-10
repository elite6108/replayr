//! Windows Fixed Version WebView2 bootstrap for broken/ghost Evergreen installs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

const FIXED_RUNTIME_DIR_NAME: &str = "webview2-fixed";
const UI_WATCHDOG_SECS: u64 = 5;

/// Point WebView2 at the bundled Fixed Version runtime before Tauri creates windows.
pub fn configure_fixed_runtime() {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        tracing::info!("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER already set; leaving as-is");
        return;
    }

    let Some(runtime_dir) = resolve_bundled_runtime_dir() else {
        tracing::warn!(
            "bundled Fixed Version WebView2 not found next to the exe; falling back to system runtime"
        );
        return;
    };

    std::env::set_var(
        "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
        runtime_dir.as_os_str(),
    );
    tracing::info!(
        path = %runtime_dir.display(),
        "using bundled Fixed Version WebView2 runtime"
    );

    if let Some(user_data) = fixed_user_data_dir() {
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
            let message = format!(
                "Replayr could not start its UI.\n\n\
WebView2 did not launch. The bundled runtime path was:\n{runtime_hint}\n\n\
If antivirus blocked msedgewebview2.exe, whitelist the Replayr install folder and try again."
            );
            tracing::error!("main UI webview failed to start; exiting");
            show_fatal_message(&message);
            app.exit(1);
        });
}

fn resolve_bundled_runtime_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
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
        let Ok(canonical) = dunce_canonicalize(&candidate) else {
            continue;
        };
        if canonical.join("msedgewebview2.exe").is_file() {
            return Some(canonical);
        }
    }
    None
}

fn dunce_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let path = path.canonicalize()?;
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        Ok(PathBuf::from(rest))
    } else {
        Ok(path)
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
    std::thread::sleep(Duration::from_millis(750));
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
    let path = runtime_dir.to_string_lossy();
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
