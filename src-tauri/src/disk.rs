use std::path::Path;

use crate::error::{AppError, AppResult};

pub fn free_bytes(path: &Path) -> AppResult<u64> {
    #[cfg(windows)]
    {
        windows_free_bytes(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(u64::MAX)
    }
}

pub fn ensure_free_space(path: &Path, min_free_bytes: u64) -> AppResult<u64> {
    let free = free_bytes(path)?;
    if free < min_free_bytes {
        let needed_gb = min_free_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
        return Err(AppError::Message(format!(
            "Not enough free disk space. Replay needs at least {needed_gb:.0} GB free."
        )));
    }
    Ok(free)
}

#[cfg(windows)]
fn windows_free_bytes(path: &Path) -> AppResult<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let target = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    let wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None)
            .map_err(|err| AppError::Message(format!("Could not read free disk space: {err}")))?;
    }
    Ok(free)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn temp_dir_reports_free_space() {
        let dir = tempdir().unwrap();
        let free = free_bytes(dir.path()).unwrap();
        assert!(free > 0);
    }

    #[test]
    fn guard_rejects_unreasonable_minimum() {
        let dir = tempdir().unwrap();
        let err = ensure_free_space(dir.path(), u64::MAX).unwrap_err();
        assert!(err.to_string().contains("free disk space"));
    }
}
