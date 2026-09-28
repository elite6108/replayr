use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::branding::APP_NAME;
use crate::error::{AppError, AppResult};

const SHORTCUT_FILE: &str = "Replayr.lnk";
const INSTALLER_FILE: &str = "Replayr.exe";
const RENAMED_INSTALLER: &str = "Replayr Setup.exe";

fn shortcut_path(app: &AppHandle) -> AppResult<PathBuf> {
    primary_desktop(app)
        .map(|dir| dir.join(SHORTCUT_FILE))
        .ok_or_else(|| AppError::Message("Could not find the Desktop folder.".into()))
}

fn primary_desktop(app: &AppHandle) -> Option<PathBuf> {
    app.path().desktop_dir().ok().or_else(|| {
        std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Desktop"))
    })
}

fn unique_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !dir.exists() {
            continue;
        }
        if out.iter().any(|existing| paths_refer_to_same(&dir, existing)) {
            continue;
        }
        out.push(dir);
    }
    out
}

fn desktop_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let onedrive = std::env::var_os("OneDrive")
        .or_else(|| std::env::var_os("ONEDRIVE"))
        .map(PathBuf::from);
    unique_dirs(
        [
            primary_desktop(app),
            home.as_ref().map(|h| h.join("Desktop")),
            home.as_ref().map(|h| h.join("OneDrive").join("Desktop")),
            onedrive.map(|root| root.join("Desktop")),
        ]
        .into_iter()
        .flatten(),
    )
}

fn download_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    unique_dirs(
        [
            app.path().download_dir().ok(),
            home.map(|h| h.join("Downloads")),
        ]
        .into_iter()
        .flatten(),
    )
}

fn start_menu_shortcut_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(SHORTCUT_FILE),
    )
}

pub fn is_installer_filename(name: &str) -> bool {
    name.eq_ignore_ascii_case(INSTALLER_FILE)
}

pub fn next_renamed_installer(dir: &Path) -> PathBuf {
    let primary = dir.join(RENAMED_INSTALLER);
    if !primary.exists() {
        return primary;
    }
    for index in 2..100 {
        let candidate = dir.join(format!("Replayr Setup ({index}).exe"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(
        "Replayr Setup-{}.exe",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ))
}

fn normalize_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    stripped.replace('/', "\\").to_ascii_lowercase()
}

fn paths_refer_to_same(left: &Path, right: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        return normalize_path_key(&a) == normalize_path_key(&b);
    }
    normalize_path_key(left) == normalize_path_key(right)
}

#[cfg(windows)]
mod windows_impl {
    use std::path::Path;

    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        IPersistFile,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    fn with_com<T>(f: impl FnOnce() -> windows::core::Result<T>) -> windows::core::Result<T> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let initialized_here = hr.is_ok();
            let result = f();
            if initialized_here {
                CoUninitialize();
            }
            result
        }
    }

    pub fn create_link(exe: &Path, dest: &Path) -> windows::core::Result<()> {
        let exe_text = HSTRING::from(exe.to_string_lossy().as_ref());
        let dest_text = HSTRING::from(dest.to_string_lossy().as_ref());
        let workdir = exe.parent().map(|dir| HSTRING::from(dir.to_string_lossy().as_ref()));
        with_com(|| unsafe {
            let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            shell.SetPath(&exe_text)?;
            if let Some(dir) = &workdir {
                shell.SetWorkingDirectory(dir)?;
            }
            shell.SetDescription(&HSTRING::from(super::APP_NAME))?;
            shell.SetIconLocation(&exe_text, 0)?;
            let persist: IPersistFile = shell.cast()?;
            persist.Save(&dest_text, true)?;
            Ok(())
        })
    }
}

fn write_link(exe: &Path, dest: &Path) -> AppResult<()> {
    #[cfg(not(windows))]
    {
        let _ = (exe, dest);
        return Err(AppError::Message("Desktop shortcuts are only available on Windows.".into()));
    }
    #[cfg(windows)]
    {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        windows_impl::create_link(exe, dest).map_err(|err| AppError::Message(err.to_string()))
    }
}

fn should_rename_leftover_installer(candidate: &Path, running_exe: &Path) -> bool {
    candidate.is_file()
        && is_installer_filename(
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        )
        && !paths_refer_to_same(candidate, running_exe)
}

fn neutralize_leftover_installer(dir: &Path, exe: &Path) {
    let candidate = dir.join(INSTALLER_FILE);
    if !should_rename_leftover_installer(&candidate, exe) {
        return;
    }
    let dest = next_renamed_installer(dir);
    match std::fs::rename(&candidate, &dest) {
        Ok(()) => tracing::info!(from = %candidate.display(), to = %dest.display(), "renamed leftover Replayr installer"),
        Err(err) => tracing::warn!(from = %candidate.display(), %err, "could not rename leftover Replayr installer"),
    }
}

/// Point Desktop/Start Menu shortcuts at this exe and move leftover silent installers aside.
/// Skipped in debug so `tauri:dev` does not rewrite the user's installed launchers.
pub fn repair_launchers(app: &AppHandle, desktop_shortcut: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    #[cfg(not(windows))]
    {
        let _ = (app, desktop_shortcut);
    }
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let desktops = desktop_dirs(app);
        let existing_desktop_shortcut = desktops.iter().any(|dir| dir.join(SHORTCUT_FILE).exists());
        if desktop_shortcut || existing_desktop_shortcut {
            for dir in &desktops {
                let dest = dir.join(SHORTCUT_FILE);
                if let Err(err) = write_link(&exe, &dest) {
                    tracing::warn!(path = %dest.display(), %err, "could not repair desktop shortcut");
                }
            }
        }
        if let Some(dest) = start_menu_shortcut_path() {
            if let Err(err) = write_link(&exe, &dest) {
                tracing::warn!(path = %dest.display(), %err, "could not repair Start Menu shortcut");
            }
        }
        for dir in desktops.iter().chain(download_dirs(app).iter()) {
            neutralize_leftover_installer(dir, &exe);
        }
    }
}

pub fn exists(app: &AppHandle) -> AppResult<bool> {
    Ok(shortcut_path(app)?.exists())
}

pub fn create(app: &AppHandle) -> AppResult<()> {
    #[cfg(not(windows))]
    {
        let _ = app;
        return Err(AppError::Message("Desktop shortcuts are only available on Windows.".into()));
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()?;
        let dest = shortcut_path(app)?;
        write_link(&exe, &dest)?;
        if let Some(start_menu) = start_menu_shortcut_path() {
            let _ = write_link(&exe, &start_menu);
        }
        Ok(())
    }
}

pub fn remove(app: &AppHandle) -> AppResult<()> {
    let dest = shortcut_path(app)?;
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn installer_filename_matches_public_download() {
        assert!(is_installer_filename("Replayr.exe"));
        assert!(is_installer_filename("replayr.EXE"));
        assert!(!is_installer_filename("replay.exe"));
        assert!(!is_installer_filename("Replayr Setup.exe"));
    }

    #[test]
    fn renamed_installer_avoids_existing_file() {
        let dir = tempdir().unwrap();
        assert_eq!(next_renamed_installer(dir.path()), dir.path().join(RENAMED_INSTALLER));
        std::fs::write(dir.path().join(RENAMED_INSTALLER), b"x").unwrap();
        assert_eq!(
            next_renamed_installer(dir.path()),
            dir.path().join("Replayr Setup (2).exe")
        );
    }

    #[test]
    fn path_compare_is_case_insensitive() {
        assert!(paths_refer_to_same(
            Path::new(r"C:\Users\a\Desktop\Replayr.exe"),
            Path::new(r"c:\users\a\desktop\replayr.exe"),
        ));
        assert!(!paths_refer_to_same(
            Path::new(r"C:\Users\a\Desktop\Replayr.exe"),
            Path::new(r"C:\Users\a\AppData\Local\Replayr\replay.exe"),
        ));
    }

    #[test]
    fn leftover_desktop_installer_is_flagged() {
        let dir = tempdir().unwrap();
        let installer = dir.path().join("Replayr.exe");
        let running = dir.path().join("replay.exe");
        std::fs::write(&installer, b"nsis").unwrap();
        std::fs::write(&running, b"app").unwrap();
        assert!(should_rename_leftover_installer(&installer, &running));
        assert!(!should_rename_leftover_installer(&running, &running));
        assert!(!should_rename_leftover_installer(&installer, &installer));
    }
}
