use std::mem::ManuallyDrop;
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaBuffer, IMFSample, IMFTransform, MEError, METransformDrainComplete,
    METransformHaveOutput, METransformNeedInput, MFCreateDXGISurfaceBuffer, MFCreateMediaType,
    MFCreateMemoryBuffer, MFCreateSample, MFCreateVideoSampleFromSurface, MFMediaType_Video,
    MFSampleExtension_CleanPoint, MFTEnumEx, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_ALL,
    MFT_FRIENDLY_NAME_Attribute, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFVideoFormat_H264,
    MFVideoFormat_NV12, MFVideoInterlace_Progressive, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO,
    MF_MT_SUBTYPE, MF_SA_D3D11_AWARE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::export::types::ComposeQuality;

use super::device::{raw_ptr, SharedGpu};
use super::{GPU_ENCODER_H, GPU_ENCODER_W};

pub(super) const BOUNDARY_ENCODER: &str = "dxgi_sample_to_encoder";
pub(super) const BOUNDARY_MISSING_MANAGER: &str = "sinkwriter_missing_d3d_manager";
#[allow(dead_code)]
const BOUNDARY_SW_PLUMBING: &str = "sinkwriter_dxgi_plumbing";
pub(super) const BOUNDARY_NOT_D3D11: &str = "encoder_not_d3d11_compatible";
#[allow(dead_code)]
const BOUNDARY_ENCODER_REJECTS: &str = "encoder_rejects_dxgi_sample";
#[allow(dead_code)]
const BOUNDARY_ENCODER_ACCEPTS: &str = "encoder_accepts_dxgi_sample";
#[allow(dead_code)]
const BOUNDARY_ENCODER_NOT_READY: &str = "encoder_still_not_ready";
#[allow(dead_code)]
const BOUNDARY_ENCODER_OTHER: &str = "encoder_process_input_other_failure";
#[allow(dead_code)]
const BOUNDARY_ASYNC_STARTUP: &str = "async_encoder_startup_failure";
pub(super) const ASYNC_EVENT_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) const PROBE_DURATION_HNS: i64 = 166_666;

pub(super) fn pick_direct_encoder_name(inventory: &[crate::camera::encoder::EncoderInfo]) -> String {
    inventory
        .iter()
        .find(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("dx12") || name.contains("nvidia") || name.contains("nvenc")
        })
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "Microsoft AVC DX12 Encoder".into())
}

pub(super) fn wrap_composed_frame(
    texture: &ID3D11Texture2D,
    time: i64,
    duration: i64,
) -> Result<IMFSample, String> {
    let (_buffer, sample) = wrap_video_sample_from_surface(texture, 0)?;
    unsafe {
        sample
            .SetSampleTime(time)
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(duration.max(1))
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
    }
    Ok(sample)
}

pub(super) fn configure_direct_encoder(
    transform: &IMFTransform,
    gpu: &SharedGpu,
    bound_aware: Option<bool>,
    fps: u32,
    bitrate: u32,
) -> Result<(), String> {
    unsafe {
        if let Ok(attrs) = transform.GetAttributes() {
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                attrs
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(|err| format!("MF_TRANSFORM_ASYNC_UNLOCK hr={:#x}", err.code().0 as u32))?;
            }
        }
        if bound_aware != Some(false) {
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, raw_ptr(&gpu.manager))
                .map_err(|err| format!("SET_D3D_MANAGER hr={:#x}", err.code().0 as u32))?;
        }
        let output_type = h264_output_type(fps, bitrate)?;
        let input_type = nv12_input_type(fps)?;
        transform
            .SetOutputType(0, &output_type, 0)
            .map_err(|err| format!("SetOutputType hr={:#x}", err.code().0 as u32))?;
        transform
            .SetInputType(0, &input_type, 0)
            .map_err(|err| format!("SetInputType hr={:#x}", err.code().0 as u32))?;
        send_lifecycle(transform, "NOTIFY_BEGIN_STREAMING", MFT_MESSAGE_NOTIFY_BEGIN_STREAMING);
        send_lifecycle(transform, "NOTIFY_START_OF_STREAM", MFT_MESSAGE_NOTIFY_START_OF_STREAM);
    }
    Ok(())
}

pub(super) fn send_lifecycle(transform: &IMFTransform, name: &str, message: windows::Win32::Media::MediaFoundation::MFT_MESSAGE_TYPE) {
    match unsafe { transform.ProcessMessage(message, 0) } {
        Ok(()) => tracing::info!(message = name, hr = "0x0", "direct encoder lifecycle message"),
        Err(err) => tracing::warn!(
            message = name,
            hr = format!("{:#x}", err.code().0 as u32),
            %err,
            "direct encoder lifecycle message failed"
        ),
    }
}

pub(super) fn wrap_blank_frame(texture: &ID3D11Texture2D, time: i64) -> Result<IMFSample, String> {
    let (_buffer, sample) = wrap_video_sample_from_surface(texture, 0)?;
    unsafe {
        sample
            .SetSampleTime(time)
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(PROBE_DURATION_HNS)
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
    }
    Ok(sample)
}

pub(super) struct EncodedNalu {
    pub(super) sample: IMFSample,
    pub(super) size: u32,
    pub(super) time: Option<i64>,
    #[allow(dead_code)]
    pub(super) duration: Option<i64>,
    /// True while the sample still belongs to the HMFT's own output allocator.
    pub(super) hmft_owned: bool,
}

#[allow(dead_code)]
fn process_one_output(transform: &IMFTransform) -> Result<u32, String> {
    Ok(take_encoded_output(transform, true)?.size)
}

/// Copies the compressed H.264 payload into a Replayr-owned sample so the HMFT can
/// recycle its own output allocation immediately. Compressed bytes only; raw video
/// surfaces are never mapped.
fn own_encoded_sample(src: &IMFSample) -> Result<IMFSample, String> {
    unsafe {
        let src_buffer = src.ConvertToContiguousBuffer().map_err(|err| {
            format!(
                "ConvertToContiguousBuffer hr={:#x} {err}",
                err.code().0 as u32
            )
        })?;
        let mut src_ptr = std::ptr::null_mut();
        let mut src_len = 0_u32;
        src_buffer
            .Lock(&mut src_ptr, None, Some(&mut src_len))
            .map_err(|err| format!("encoded Lock hr={:#x} {err}", err.code().0 as u32))?;
        let copy = (|| -> Result<IMFMediaBuffer, String> {
            let dest_buffer = MFCreateMemoryBuffer(src_len.max(1))
                .map_err(|err| format!("MFCreateMemoryBuffer hr={:#x}", err.code().0 as u32))?;
            let mut dest_ptr = std::ptr::null_mut();
            dest_buffer
                .Lock(&mut dest_ptr, None, None)
                .map_err(|err| format!("owned Lock hr={:#x}", err.code().0 as u32))?;
            std::ptr::copy_nonoverlapping(src_ptr, dest_ptr, src_len as usize);
            let _ = dest_buffer.Unlock();
            dest_buffer
                .SetCurrentLength(src_len)
                .map_err(|err| format!("SetCurrentLength hr={:#x}", err.code().0 as u32))?;
            Ok(dest_buffer)
        })();
        let _ = src_buffer.Unlock();
        let dest_buffer = copy?;
        let dest = MFCreateSample()
            .map_err(|err| format!("MFCreateSample hr={:#x}", err.code().0 as u32))?;
        dest.AddBuffer(&dest_buffer)
            .map_err(|err| format!("owned AddBuffer hr={:#x}", err.code().0 as u32))?;
        // Carries CleanPoint, Discontinuity and every other encoder attribute across.
        src.CopyAllItems(&dest)
            .map_err(|err| format!("CopyAllItems hr={:#x}", err.code().0 as u32))?;
        if let Ok(time) = src.GetSampleTime() {
            let _ = dest.SetSampleTime(time);
        }
        if let Ok(duration) = src.GetSampleDuration() {
            let _ = dest.SetSampleDuration(duration);
        }
        if let Ok(flags) = src.GetSampleFlags() {
            let _ = dest.SetSampleFlags(flags);
        }
        Ok(dest)
    }
}

pub(super) fn take_encoded_output(transform: &IMFTransform, log: bool) -> Result<EncodedNalu, String> {
    unsafe {
        let info = transform
            .GetOutputStreamInfo(0)
            .map_err(|err| format!("GetOutputStreamInfo hr={:#x}", err.code().0 as u32))?;
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let sample = if provides {
            None
        } else {
            let sample = MFCreateSample().map_err(|err| err.to_string())?;
            if info.cbSize > 0 {
                let buffer = MFCreateMemoryBuffer(info.cbSize).map_err(|err| err.to_string())?;
                sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
            }
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = transform.ProcessOutput(0, &mut buffers, &mut status);
        let out = ManuallyDrop::take(&mut buffers[0].pSample);
        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
        match result {
            Ok(()) => {
                let hmft_sample =
                    out.ok_or_else(|| "ProcessOutput returned no sample".to_string())?;
                // Release the HMFT's own output allocation before returning, otherwise the
                // MP4 sink retains it for the whole clip and the encoder runs dry.
                let encoded = if provides {
                    let owned = own_encoded_sample(&hmft_sample)?;
                    drop(hmft_sample);
                    owned
                } else {
                    hmft_sample
                };
                let size = encoded.GetTotalLength().unwrap_or(0);
                let time = encoded.GetSampleTime().ok();
                let duration = encoded.GetSampleDuration().ok();
                let flags = encoded.GetSampleFlags().ok();
                if log {
                    tracing::info!(
                        process_output_hr = "0x0",
                        sample_size = size,
                        timestamp = time,
                        duration,
                        flags,
                        stream_status = status,
                        "direct encode ProcessOutput sample"
                    );
                }
                Ok(EncodedNalu {
                    sample: encoded,
                    size,
                    time,
                    duration,
                    hmft_owned: false,
                })
            }
            Err(err) => Err(format!(
                "ProcessOutput hr={:#x} {err}",
                err.code().0 as u32
            )),
        }
    }
}

pub(super) fn d3d11_aware(transform: &IMFTransform) -> Option<bool> {
    unsafe {
        let attrs = transform.GetAttributes().ok()?;
        match attrs.GetUINT32(&MF_SA_D3D11_AWARE) {
            Ok(value) => Some(value != 0),
            Err(_) => None,
        }
    }
}

pub(super) fn event_name(ty: u32) -> &'static str {
    if ty == METransformNeedInput.0 as u32 {
        "METransformNeedInput"
    } else if ty == METransformHaveOutput.0 as u32 {
        "METransformHaveOutput"
    } else if ty == METransformDrainComplete.0 as u32 {
        "METransformDrainComplete"
    } else if ty == MEError.0 as u32 {
        "MEError"
    } else {
        "other"
    }
}

pub(super) fn process_input_hr(transform: &IMFTransform, sample: &IMFSample, which: &str) -> String {
    unsafe {
        match transform.ProcessInput(0, sample, 0) {
            Ok(()) => {
                if which != "compose" && which != "blank_long" {
                    tracing::info!(
                        which,
                        process_input_hr = "0x0",
                        "IMFTransform::ProcessInput succeeded"
                    );
                }
                "0x0".into()
            }
            Err(err) => {
                let hr = format!("{:#x}", err.code().0 as u32);
                tracing::error!(
                    which,
                    process_input_hr = %hr,
                    %err,
                    "IMFTransform::ProcessInput failed"
                );
                hr
            }
        }
    }
}

pub(super) fn activate_named_h264_encoder(selected: &str) -> Option<IMFTransform> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let result = unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_ALL,
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
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(raw, count as usize) };
    let mut names = Vec::new();
    let mut chosen = None;
    for item in slice {
        let Some(activate) = item else {
            continue;
        };
        let name = unsafe {
            let mut pwstr = windows::core::PWSTR::null();
            let mut len = 0u32;
            if activate
                .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
                .is_ok()
                && !pwstr.is_null()
            {
                let value = pwstr.to_string().unwrap_or_default();
                CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
                value
            } else {
                String::new()
            }
        };
        if !name.is_empty() {
            names.push(name.clone());
        }
        if chosen.is_none() && (name.eq_ignore_ascii_case(selected) || selected.contains(&name) || name.contains(selected))
        {
            chosen = Some(activate.clone());
        }
    }
    tracing::info!(
        all_enum_flag = MFT_ENUM_FLAG_ALL.0,
        candidates = ?names,
        selected,
        matched = chosen.is_some(),
        "H.264 MFTEnumEx(ALL) candidates for direct ProcessInput"
    );
    let transform = chosen.and_then(|activate| unsafe { activate.ActivateObject::<IMFTransform>().ok() });
    unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
    transform
}

/// The direct encoder always emits [`GPU_ENCODER_W`]x[`GPU_ENCODER_H`], so the
/// tier resolves against that rather than the source frame size.
pub(super) fn gpu_encoder_bitrate(quality: ComposeQuality, fps: u32) -> u32 {
    quality.bitrate_for(GPU_ENCODER_W, GPU_ENCODER_H, fps)
}

pub(super) fn h264_output_type(
    fps: u32,
    bitrate: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

pub(super) fn nv12_input_type(
    fps: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

pub(super) fn log_nvidia_selection(inventory: &[crate::camera::encoder::EncoderInfo], selected: &str) {
    let hardware: Vec<&str> = inventory
        .iter()
        .filter(|item| item.hardware)
        .map(|item| item.name.as_str())
        .collect();
    let software: Vec<&str> = inventory
        .iter()
        .filter(|item| !item.hardware)
        .map(|item| item.name.as_str())
        .collect();
    tracing::info!(
        hardware = ?hardware,
        software = ?software,
        selected,
        "H.264 encoder MFT candidates and selected transform"
    );
    let nvidia: Vec<&str> = inventory
        .iter()
        .filter(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("nvidia") || name.contains("nvenc")
        })
        .map(|item| item.name.as_str())
        .collect();
    let selected_nvidia = {
        let name = selected.to_ascii_lowercase();
        name.contains("nvidia") || name.contains("nvenc")
    };
    if nvidia.is_empty() {
        tracing::info!(
            selected,
            "NVIDIA H.264 MFT was not selected because it was not enumerated"
        );
    } else if selected_nvidia {
        tracing::info!(selected, nvidia = ?nvidia, "NVIDIA H.264 MFT was selected");
    } else {
        tracing::info!(
            selected,
            nvidia = ?nvidia,
            "NVIDIA MFT was enumerated but SinkWriter bound a different transform; MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS does not pin a vendor"
        );
    }
}

pub(super) fn wrap_video_sample_from_surface(
    texture: &ID3D11Texture2D,
    subresource: u32,
) -> Result<(IMFMediaBuffer, IMFSample), String> {
    unsafe {
        let media_buffer = MFCreateDXGISurfaceBuffer(
            &ID3D11Texture2D::IID,
            texture,
            subresource,
            false,
        )
        .map_err(|err| {
            format!(
                "wrap_hr={:#x} MFCreateDXGISurfaceBuffer failed: {err}",
                err.code().0 as u32
            )
        })?;
        let sample = MFCreateVideoSampleFromSurface(None).map_err(|err| {
            format!(
                "wrap_hr={:#x} MFCreateVideoSampleFromSurface failed: {err}",
                err.code().0 as u32
            )
        })?;
        sample.AddBuffer(&media_buffer).map_err(|err| {
            format!(
                "wrap_hr={:#x} IMFSample::AddBuffer failed: {err}",
                err.code().0 as u32
            )
        })?;
        sample
            .SetSampleTime(0)
            .map_err(|err| format!("wrap_hr={:#x} SetSampleTime failed: {err}", err.code().0 as u32))?;
        sample.SetSampleDuration(PROBE_DURATION_HNS).map_err(|err| {
            format!(
                "wrap_hr={:#x} SetSampleDuration failed: {err}",
                err.code().0 as u32
            )
        })?;
        let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        Ok((media_buffer, sample))
    }
}