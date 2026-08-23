use crate::games::ProcessRef;

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    use super::ProcessRef;

    struct Snapshot(HANDLE);

    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn wchar_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|ch| *ch == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    pub fn list_processes() -> Vec<ProcessRef> {
        let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
            Ok(handle) if !handle.is_invalid() => Snapshot(handle),
            _ => return Vec::new(),
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
            return Vec::new();
        }

        let mut processes = Vec::new();
        loop {
            let name = wchar_to_string(&entry.szExeFile);
            if !name.is_empty() {
                processes.push(ProcessRef {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name,
                });
            }
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                break;
            }
        }
        processes
    }

    pub fn foreground_pid() -> Option<u32> {
        let hwnd: HWND = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if thread_id == 0 || pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}

#[cfg(not(windows))]
mod windows_impl {
    use super::ProcessRef;

    pub fn list_processes() -> Vec<ProcessRef> {
        Vec::new()
    }

    pub fn foreground_pid() -> Option<u32> {
        None
    }
}

pub use windows_impl::{foreground_pid, list_processes};
