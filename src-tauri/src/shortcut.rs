use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::branding::APP_NAME;
use crate::error::{AppError, AppResult};

const SHORTCUT_FILE: &str = "Replayr.lnk";

fn shortcut_path(app: &AppHandle) -> AppResult<PathBuf> {
    let desktop = app.path().desktop_dir().ok().or_else(|| {
        std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Desktop"))
    });
    let desktop = desktop.ok_or_else(|| AppError::Message("Could not find the Desktop folder.".into()))?;
    Ok(desktop.join(SHORTCUT_FILE))
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
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        windows_impl::create_link(&exe, &dest).map_err(|err| AppError::Message(err.to_string()))
    }
}

pub fn remove(app: &AppHandle) -> AppResult<()> {
    let dest = shortcut_path(app)?;
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    Ok(())
}
