//! Recording-safe monitor enumeration. Frontend IDs are untrusted.

use serde::Serialize;

#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
#[cfg(windows)]
use windows_capture::monitor::Monitor;

const MAX_MONITOR_ID: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    pub is_primary: bool,
    pub x: i32,
    pub y: i32,
}

pub fn sanitize_monitor_id(raw: Option<&str>) -> Option<String> {
    let value = raw.map(str::trim).filter(|value| !value.is_empty())?;
    if value.len() > MAX_MONITOR_ID {
        return None;
    }
    if !value.starts_with(r"\\.\DISPLAY") {
        return None;
    }
    if !value.as_bytes().iter().skip(r"\\.\DISPLAY".len()).all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(value.to_string())
}

#[cfg(windows)]
pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    let monitors = Monitor::enumerate().map_err(|err| err.to_string())?;
    let primary_id = Monitor::primary()
        .ok()
        .and_then(|monitor| monitor.device_name().ok());
    let mut out = Vec::new();
    for monitor in monitors {
        let Some(info) = display_info(&monitor, primary_id.as_deref()) else {
            continue;
        };
        out.push(info);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[cfg(not(windows))]
pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    Ok(Vec::new())
}

/// Resolve a saved Windows display device name such as `\\.\DISPLAY2`.
/// That id is a re-resolvable Windows identifier, not a permanently stable
/// physical-monitor identity. If it is missing, use primary for this start
/// only. Never write the fallback back to the scene.
#[cfg(windows)]
pub fn resolve_monitor(monitor_id: Option<&str>) -> Result<Monitor, String> {
    let wanted = sanitize_monitor_id(monitor_id);
    if let Some(id) = wanted.as_deref() {
        if let Some(monitor) = find_monitor(id) {
            return Ok(monitor);
        }
        tracing::warn!(id, "saved display is unavailable; using primary for this session");
    }
    Monitor::primary().map_err(|err| err.to_string())
}

/// Recording must never silently capture a different screen than the one the user picked.
/// `None` means the user chose Primary.
#[cfg(windows)]
pub fn resolve_monitor_for_recording(monitor_id: Option<&str>) -> Result<Monitor, String> {
    let available: Vec<String> = Monitor::enumerate()
        .map_err(|err| err.to_string())?
        .iter()
        .filter_map(|monitor| monitor.device_name().ok())
        .collect();
    match pick_recording_monitor(monitor_id, &available)? {
        Some(id) => find_monitor(&id).ok_or_else(|| missing_display_message(&id)),
        None => Monitor::primary().map_err(|err| err.to_string()),
    }
}

fn pick_recording_monitor(monitor_id: Option<&str>, available: &[String]) -> Result<Option<String>, String> {
    let raw = monitor_id.map(str::trim).filter(|value| !value.is_empty());
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Some(id) = sanitize_monitor_id(Some(raw)) else {
        return Err("The selected display is not valid. Pick a display in the Desktop source.".into());
    };
    if available.iter().any(|item| item == &id) {
        Ok(Some(id))
    } else {
        Err(missing_display_message(&id))
    }
}

fn missing_display_message(id: &str) -> String {
    let short = id.rsplit('\\').next().unwrap_or(id);
    format!("{short} is not connected. Reconnect it or pick another display in the Desktop source.")
}

/// Device-interface path of the monitor attached to `\\.\DISPLAYn`, such as
/// `\\?\DISPLAY#GSM5B09#5&2d1e4c5&0&UID4353#{e6f07b5f-...}`. OBS saves this as `monitor_id`.
#[cfg(windows)]
pub fn monitor_interface_id(device_name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x0000_0001;

    let device_name = sanitize_monitor_id(Some(device_name))?;
    let wide: Vec<u16> = device_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut device = DISPLAY_DEVICEW {
        cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let found = unsafe { EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, &mut device, EDD_GET_DEVICE_INTERFACE_NAME) };
    if !found.as_bool() {
        return None;
    }
    let len = device.DeviceID.iter().position(|unit| *unit == 0).unwrap_or(device.DeviceID.len());
    let id = String::from_utf16_lossy(&device.DeviceID[..len]);
    (!id.trim().is_empty()).then_some(id)
}

#[cfg(not(windows))]
pub fn monitor_interface_id(_device_name: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn find_monitor(id: &str) -> Option<Monitor> {
    Monitor::enumerate().ok()?.into_iter().find(|monitor| monitor.device_name().ok().as_deref() == Some(id))
}

#[cfg(windows)]
fn display_info(monitor: &Monitor, primary_id: Option<&str>) -> Option<DisplayInfo> {
    let id = monitor.device_name().ok()?;
    let width = monitor.width().unwrap_or(0);
    let height = monitor.height().unwrap_or(0);
    let refresh_rate = monitor.refresh_rate().unwrap_or(0);
    let name = monitor.name().unwrap_or_else(|_| fallback_name(&id));
    let (x, y, is_primary_flag) = monitor_rect(monitor);
    Some(DisplayInfo {
        is_primary: is_primary_flag || primary_id == Some(id.as_str()),
        id,
        name,
        width,
        height,
        refresh_rate,
        x,
        y,
    })
}

#[cfg(windows)]
fn fallback_name(id: &str) -> String {
    id.rsplit('\\').next().unwrap_or(id).to_string()
}

#[cfg(windows)]
fn monitor_rect(monitor: &Monitor) -> (i32, i32, bool) {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let handle = HMONITOR(monitor.as_raw_hmonitor());
    if !unsafe { GetMonitorInfoW(handle, &mut info) }.as_bool() {
        return (0, 0, false);
    }
    (
        info.rcMonitor.left,
        info.rcMonitor.top,
        info.dwFlags & 1 != 0,
    )
}

#[cfg(test)]
mod tests {
    use super::{pick_recording_monitor, sanitize_monitor_id};

    #[test]
    fn recording_uses_the_picked_display_or_errors() {
        let available = vec![r"\\.\DISPLAY1".to_string(), r"\\.\DISPLAY2".to_string()];
        assert_eq!(pick_recording_monitor(None, &available), Ok(None));
        assert_eq!(pick_recording_monitor(Some(""), &available), Ok(None));
        assert_eq!(
            pick_recording_monitor(Some(r"\\.\DISPLAY2"), &available),
            Ok(Some(r"\\.\DISPLAY2".to_string()))
        );
        let missing = pick_recording_monitor(Some(r"\\.\DISPLAY3"), &available).unwrap_err();
        assert!(missing.contains("DISPLAY3"), "{missing}");
        assert!(pick_recording_monitor(Some("Monitor 1"), &available).is_err());
    }

    #[test]
    fn accepts_windows_display_device_names() {
        assert_eq!(
            sanitize_monitor_id(Some(r"\\.\DISPLAY2")),
            Some(r"\\.\DISPLAY2".into())
        );
        assert_eq!(sanitize_monitor_id(Some("Monitor 1")), None);
        assert_eq!(sanitize_monitor_id(Some("")), None);
        assert_eq!(sanitize_monitor_id(None), None);
    }
}
