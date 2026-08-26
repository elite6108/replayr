//! Windows Media Foundation camera enumeration.

#![cfg(windows)]

use std::time::Duration;

use windows::core::{GUID, PWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFPresentationDescriptor, IMFStreamDescriptor,
    MFCreateAttributes, MFEnumDeviceSources, MFMediaType_Video, MFStartup, MFVideoFormat_MJPG,
    MFVideoFormat_NV12, MFVideoFormat_RGB32, MFVideoFormat_YUY2, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE, MFSTARTUP_FULL, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

use super::format::{CameraMode, CameraSubtype};
use super::types::CameraDeviceInfo;

pub fn ensure_mf() -> Result<(), String> {
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(mf_error)
}

pub fn ensure_com() -> Result<(), String> {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    Ok(())
}

pub fn list_devices() -> Result<Vec<CameraDeviceInfo>, String> {
    with_com(|| {
        ensure_mf()?;
        unsafe { list_devices_inner() }
    })
}

pub fn list_modes(device_id: &str) -> Result<Vec<CameraMode>, String> {
    with_com(|| {
        ensure_mf()?;
        unsafe { list_modes_inner(device_id) }
    })
}

pub fn permission_message(err: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("denied") || lower.contains("access") || lower.contains("0x80070005") {
        "Windows blocked the camera. Allow Replayr in Windows Privacy settings.".into()
    } else if lower.contains("busy") || lower.contains("in use") || lower.contains("0xc00d3704") {
        "That camera is already in use by another app.".into()
    } else {
        format!("Could not open the camera. {err}")
    }
}

fn with_com<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    ensure_com()?;
    work()
}

unsafe fn list_devices_inner() -> Result<Vec<CameraDeviceInfo>, String> {
    let activates = enum_activates()?;
    let mut devices = Vec::new();
    for activate in &activates {
        let id = allocated_string(activate, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK)
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let name = allocated_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
            .unwrap_or_else(|| "Camera".into());
        devices.push(CameraDeviceInfo { id, name });
    }
    Ok(devices)
}

unsafe fn list_modes_inner(device_id: &str) -> Result<Vec<CameraMode>, String> {
    let source = activate_source(device_id)?;
    let result = modes_from_source(&source);
    let _ = source.Shutdown();
    result
}

pub unsafe fn activate_source(device_id: &str) -> Result<IMFMediaSource, String> {
    let activates = enum_activates()?;
    for activate in activates {
        let id = allocated_string(&activate, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK)
            .unwrap_or_default();
        if id != device_id {
            continue;
        }
        return activate
            .ActivateObject::<IMFMediaSource>()
            .map_err(|err| permission_message(&err.to_string()));
    }
    Err("That camera is not connected.".into())
}

unsafe fn enum_activates() -> Result<Vec<IMFActivate>, String> {
    let mut attrs = None;
    MFCreateAttributes(&mut attrs, 1).map_err(mf_error)?;
    let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
    attrs
        .SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
        .map_err(mf_error)?;
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    MFEnumDeviceSources(&attrs, &mut raw, &mut count).map_err(mf_error)?;
    if raw.is_null() || count == 0 {
        return Ok(Vec::new());
    }
    let slice = std::slice::from_raw_parts(raw, count as usize);
    let mut activates = Vec::new();
    for item in slice {
        if let Some(activate) = item {
            activates.push(activate.clone());
        }
    }
    CoTaskMemFree(Some(raw as *const std::ffi::c_void));
    Ok(activates)
}

unsafe fn modes_from_source(source: &IMFMediaSource) -> Result<Vec<CameraMode>, String> {
    let descriptor: IMFPresentationDescriptor = source.CreatePresentationDescriptor().map_err(mf_error)?;
    let stream_count = descriptor.GetStreamDescriptorCount().map_err(mf_error)?;
    let mut modes = Vec::new();
    for index in 0..stream_count {
        let mut selected = BOOL::default();
        let mut stream: Option<IMFStreamDescriptor> = None;
        descriptor
            .GetStreamDescriptorByIndex(index, &mut selected, &mut stream)
            .map_err(mf_error)?;
        let Some(stream) = stream else {
            continue;
        };
        let handler = stream.GetMediaTypeHandler().map_err(mf_error)?;
        let major = handler.GetMajorType().unwrap_or_default();
        if major != MFMediaType_Video {
            continue;
        }
        let type_count = handler.GetMediaTypeCount().map_err(mf_error)?;
        for type_index in 0..type_count {
            let media_type = handler.GetMediaTypeByIndex(type_index).map_err(mf_error)?;
            if let Some(mode) = mode_from_media_type(&media_type) {
                if !modes.iter().any(|existing: &CameraMode| {
                    existing.width == mode.width
                        && existing.height == mode.height
                        && existing.fps == mode.fps
                        && existing.native_subtype == mode.native_subtype
                }) {
                    modes.push(mode);
                }
            }
        }
    }
    Ok(modes)
}

fn mode_from_media_type(media_type: &IMFMediaType) -> Option<CameraMode> {
    unsafe {
        let subtype = media_type.GetGUID(&MF_MT_SUBTYPE).ok()?;
        let frame = media_type.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
        let rate = media_type.GetUINT64(&MF_MT_FRAME_RATE).ok()?;
        let width = (frame >> 32) as u32;
        let height = frame as u32;
        let fps_num = (rate >> 32) as u32;
        let fps_den = (rate as u32).max(1);
        let fps = (fps_num / fps_den).max(1);
        Some(CameraMode {
            width,
            height,
            fps,
            native_subtype: subtype_from_guid(subtype),
        })
    }
}

pub fn subtype_from_guid(guid: GUID) -> CameraSubtype {
    if guid == MFVideoFormat_NV12 {
        CameraSubtype::Nv12
    } else if guid == MFVideoFormat_YUY2 {
        CameraSubtype::Yuy2
    } else if guid == MFVideoFormat_MJPG {
        CameraSubtype::Mjpeg
    } else if guid == MFVideoFormat_RGB32 {
        CameraSubtype::Rgb32
    } else {
        CameraSubtype::Other
    }
}

pub fn guid_from_subtype(subtype: CameraSubtype) -> Option<GUID> {
    match subtype {
        CameraSubtype::Nv12 => Some(MFVideoFormat_NV12),
        CameraSubtype::Yuy2 => Some(MFVideoFormat_YUY2),
        CameraSubtype::Mjpeg => Some(MFVideoFormat_MJPG),
        CameraSubtype::Rgb32 => Some(MFVideoFormat_RGB32),
        CameraSubtype::Other => None,
    }
}

unsafe fn allocated_string(attrs: &IMFActivate, key: &GUID) -> Option<String> {
    let pwstr = attrs.GetAllocatedString(key).ok()?;
    let value = pwstr_to_string(pwstr);
    CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
    if value.is_empty() { None } else { Some(value) }
}

unsafe fn pwstr_to_string(ptr: PWSTR) -> String {
    if ptr.0.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.0.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr.0, len))
}

pub fn mf_error(err: windows::core::Error) -> String {
    err.message().to_string()
}

pub fn run_off_ui<T, E, F>(name: &'static str, timeout: Duration, work: F) -> Result<T, String>
where
    T: Send + 'static,
    E: ToString,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _ = tx.send(work().map_err(|err| err.to_string()));
        })
        .map_err(|err| err.to_string())?;
    rx.recv_timeout(timeout)
        .map_err(|_| format!("{name} timed out"))?
}

#[allow(dead_code)]
fn _keep_attr_type(_: &IMFAttributes) {}
