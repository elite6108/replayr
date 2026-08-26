//! H.264 encoder inventory and SinkWriter open path for webcam.
//!
//! `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS` is a *request*, not proof the
//! encoder is hardware. We enumerate MFTs, try hardware first, and fall back
//! to a bounded software H.264 MFT without disabling webcam unless software
//! fails or exceeds the safety threshold.

#![cfg(windows)]

use std::path::Path;

use windows::core::{GUID, Interface};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFSinkWriterEx, IMFTransform, MFTEnumEx, MFT_ENUM_FLAG,
    MFT_ENUM_FLAG_ASYNCMFT, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT,
    MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFMediaType_Video, MFVideoFormat_H264,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::encode::{MfWriter, VideoInput};

use super::device::mf_error;

#[derive(Debug, Clone)]
pub struct EncoderInfo {
    pub name: String,
    pub hardware: bool,
}

#[derive(Debug, Clone)]
pub struct OpenedEncoder {
    pub writer: MfWriter,
    pub name: String,
    pub hardware_requested: bool,
    pub software_fallback: bool,
    pub transform_name: Option<String>,
}

pub fn log_h264_inventory() -> Vec<EncoderInfo> {
    let hardware = enum_h264(true);
    let software = enum_h264(false);
    tracing::info!(
        hardware = ?hardware.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(),
        software = ?software.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(),
        "H.264 MFT inventory (SinkWriter hardware flag is a request, not proof)"
    );
    let mut all = hardware;
    all.extend(software);
    all
}

pub fn open_webcam_writer(
    path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<OpenedEncoder, String> {
    let inventory = log_h264_inventory();
    let hardware_available = inventory.iter().any(|item| item.hardware);
    match open_writer(path, width, height, fps, bitrate, true) {
        Ok(writer) => {
            let transform_name = sink_transform_name(&writer);
            let name = transform_name
                .clone()
                .or_else(|| {
                    inventory
                        .iter()
                        .find(|item| item.hardware)
                        .map(|item| item.name.clone())
                })
                .unwrap_or_else(|| "H.264 (hardware transforms requested)".into());
            tracing::info!(
                encoder = %name,
                transform = ?transform_name,
                hardware_available,
                "webcam SinkWriter opened with hardware transforms requested"
            );
            if !hardware_available {
                tracing::warn!(
                    "no hardware H.264 MFT was enumerated; do not treat this session as hardware-encoded"
                );
            }
            Ok(OpenedEncoder {
                writer,
                name,
                hardware_requested: true,
                software_fallback: false,
                transform_name,
            })
        }
        Err(err) => {
            tracing::warn!(%err, "hardware-transform webcam encoder failed; trying software H.264 MFT");
            let writer = open_writer(path, width, height, fps, bitrate, false).map_err(|software_err| {
                format!("Webcam encoder failed (hardware: {err}; software: {software_err})")
            })?;
            let transform_name = sink_transform_name(&writer);
            let name = transform_name
                .clone()
                .or_else(|| {
                    inventory
                        .iter()
                        .find(|item| !item.hardware)
                        .map(|item| item.name.clone())
                })
                .unwrap_or_else(|| "Microsoft software H.264".into());
            tracing::warn!(
                encoder = %name,
                transform = ?transform_name,
                "webcam using software H.264 fallback; gameplay continues"
            );
            Ok(OpenedEncoder {
                writer,
                name,
                hardware_requested: false,
                software_fallback: true,
                transform_name,
            })
        }
    }
}

fn open_writer(
    path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    hardware: bool,
) -> Result<MfWriter, String> {
    MfWriter::create(
        path,
        width,
        height,
        fps,
        bitrate,
        false,
        None,
        false,
        VideoInput::Nv12,
        hardware,
    )
}

fn sink_transform_name(writer: &MfWriter) -> Option<String> {
    unsafe {
        let ex: IMFSinkWriterEx = writer.sink_writer().cast().ok()?;
        let mut category = GUID::zeroed();
        let mut transform: Option<IMFTransform> = None;
        ex.GetTransformForStream(writer.video_stream_index(), 0, &mut category, &mut transform)
            .ok()?;
        let transform = transform?;
        let attrs = transform.GetAttributes().ok()?;
        allocated_name(&attrs).ok().flatten()
    }
}

fn enum_h264(hardware: bool) -> Vec<EncoderInfo> {
    let flags = if hardware {
        MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0
    } else {
        MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_ASYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let result = unsafe {
        MFTEnumEx(
            windows::Win32::Media::MediaFoundation::MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG(flags),
            None,
            Some(&output),
            &mut raw,
            &mut count,
        )
    };
    if result.is_err() || raw.is_null() || count == 0 {
        if !raw.is_null() {
            unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
        }
        return Vec::new();
    }
    let slice = unsafe { std::slice::from_raw_parts(raw, count as usize) };
    let mut out = Vec::new();
    for item in slice {
        if let Some(activate) = item {
            let name = allocated_name(activate).ok().flatten().unwrap_or_else(|| {
                if hardware {
                    "Hardware H.264 MFT".into()
                } else {
                    "Software H.264 MFT".into()
                }
            });
            out.push(EncoderInfo { name, hardware });
        }
    }
    unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
    out
}

fn allocated_name(attrs: &impl GetFriendlyName) -> Result<Option<String>, String> {
    attrs.friendly_name()
}

trait GetFriendlyName {
    fn friendly_name(&self) -> Result<Option<String>, String>;
}

impl GetFriendlyName for IMFActivate {
    fn friendly_name(&self) -> Result<Option<String>, String> {
        unsafe {
            let pwstr = self
                .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute)
                .map_err(mf_error)?;
            let value = super::device::pwstr_to_owned(pwstr);
            CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
            Ok(if value.is_empty() { None } else { Some(value) })
        }
    }
}

impl GetFriendlyName for windows::Win32::Media::MediaFoundation::IMFAttributes {
    fn friendly_name(&self) -> Result<Option<String>, String> {
        unsafe {
            let pwstr = self
                .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute)
                .map_err(mf_error)?;
            let value = super::device::pwstr_to_owned(pwstr);
            CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
            Ok(if value.is_empty() { None } else { Some(value) })
        }
    }
}
