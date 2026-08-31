use windows::core::{Interface, GUID};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;
use windows::Win32::Media::MediaFoundation::{
    IMFDXGIBuffer, IMFMediaBuffer, IMFSample, MFMediaType_Video, MFSampleExtension_CleanPoint,
    MFVideoFormat_H264, MFVideoFormat_NV12, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_LEVEL, MF_MT_MPEG2_PROFILE,
    MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY, MF_MT_MPEG4_SAMPLE_DESCRIPTION, MF_MT_MPEG_SEQUENCE_HEADER,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_USER_DATA,
};
use windows::Win32::System::Com::CoTaskMemFree;

use super::decode::dxgi_texture;
use super::device::{adapter_luid, format_name, raw_ptr, texture_device, SharedGpu};

#[derive(Clone)]
pub(super) struct SurfaceHop {
    hop: String,
    texture: String,
    subresource: u32,
    format: String,
    width: u32,
    height: u32,
    bind_flags: String,
    array_size: u32,
    mip_levels: u32,
    device: String,
    ring_slot: i64,
    decoder_slice: u32,
    hr: String,
}

pub(super) fn hr_u32(detail: &str) -> u32 {
    if let Some(start) = detail.find("hr=0x") {
        let hex: String = detail[start + 5..]
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        return u32::from_str_radix(&hex, 16).unwrap_or(0);
    }
    0
}

pub(super) fn dump_complete_media_type(label: &str, media: &windows::Win32::Media::MediaFoundation::IMFMediaType) {
    unsafe {
        let major = guid_name(media.GetGUID(&MF_MT_MAJOR_TYPE).ok());
        let subtype = guid_name(media.GetGUID(&MF_MT_SUBTYPE).ok());
        let frame_size = media.GetUINT64(&MF_MT_FRAME_SIZE).ok();
        let frame_rate = media.GetUINT64(&MF_MT_FRAME_RATE).ok();
        let par = media.GetUINT64(&MF_MT_PIXEL_ASPECT_RATIO).ok();
        let interlace = media.GetUINT32(&MF_MT_INTERLACE_MODE).ok();
        let profile = media.GetUINT32(&MF_MT_MPEG2_PROFILE).ok();
        let level = media.GetUINT32(&MF_MT_MPEG2_LEVEL).ok();
        let bitrate = media.GetUINT32(&MF_MT_AVG_BITRATE).ok();
        let seq = blob_summary(media, &MF_MT_MPEG_SEQUENCE_HEADER);
        let user = blob_summary(media, &MF_MT_USER_DATA);
        let mpeg4_desc = blob_summary(media, &MF_MT_MPEG4_SAMPLE_DESCRIPTION);
        let mpeg4_entry = media.GetUINT32(&MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY).ok();
        let (width, height) = frame_size
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        let (rate_n, rate_d) = frame_rate
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        let (par_n, par_d) = par
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        tracing::info!(
            label,
            major,
            subtype,
            width,
            height,
            frame_rate = format!("{rate_n}/{rate_d}"),
            par = format!("{par_n}/{par_d}"),
            interlace,
            mpeg2_profile = profile,
            mpeg2_level = level,
            avg_bitrate = bitrate,
            mpeg_sequence_header = seq.as_str(),
            user_data = user.as_str(),
            mpeg4_sample_description = mpeg4_desc.as_str(),
            mpeg4_current_sample_entry = mpeg4_entry,
            "complete IMFMediaType"
        );
        if let Ok(count) = media.GetCount() {
            for index in 0..count {
                let mut key = GUID::zeroed();
                if media.GetItemByIndex(index, &mut key, None).is_err() {
                    continue;
                }
                let name = known_mt_name(&key);
                if let Ok(guid) = media.GetGUID(&key) {
                    tracing::info!(label, index, attr = name, kind = "guid", value = guid_name(Some(guid)), "media type attribute");
                } else if let Ok(value) = media.GetUINT64(&key) {
                    tracing::info!(label, index, attr = name, kind = "uint64", value, "media type attribute");
                } else if let Ok(value) = media.GetUINT32(&key) {
                    tracing::info!(label, index, attr = name, kind = "uint32", value, "media type attribute");
                } else {
                    tracing::info!(
                        label,
                        index,
                        attr = name,
                        kind = "other",
                        blob = blob_summary(media, &key).as_str(),
                        "media type attribute"
                    );
                }
            }
        }
    }
}

fn known_mt_name(guid: &GUID) -> String {
    if *guid == MF_MT_MAJOR_TYPE {
        "MF_MT_MAJOR_TYPE".into()
    } else if *guid == MF_MT_SUBTYPE {
        "MF_MT_SUBTYPE".into()
    } else if *guid == MF_MT_FRAME_SIZE {
        "MF_MT_FRAME_SIZE".into()
    } else if *guid == MF_MT_FRAME_RATE {
        "MF_MT_FRAME_RATE".into()
    } else if *guid == MF_MT_PIXEL_ASPECT_RATIO {
        "MF_MT_PIXEL_ASPECT_RATIO".into()
    } else if *guid == MF_MT_INTERLACE_MODE {
        "MF_MT_INTERLACE_MODE".into()
    } else if *guid == MF_MT_MPEG2_PROFILE {
        "MF_MT_MPEG2_PROFILE".into()
    } else if *guid == MF_MT_MPEG2_LEVEL {
        "MF_MT_MPEG2_LEVEL".into()
    } else if *guid == MF_MT_AVG_BITRATE {
        "MF_MT_AVG_BITRATE".into()
    } else if *guid == MF_MT_MPEG_SEQUENCE_HEADER {
        "MF_MT_MPEG_SEQUENCE_HEADER".into()
    } else if *guid == MF_MT_USER_DATA {
        "MF_MT_USER_DATA".into()
    } else if *guid == MF_MT_MPEG4_SAMPLE_DESCRIPTION {
        "MF_MT_MPEG4_SAMPLE_DESCRIPTION".into()
    } else if *guid == MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY {
        "MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY".into()
    } else {
        format!("{guid:?}")
    }
}

fn guid_name(guid: Option<GUID>) -> String {
    match guid {
        Some(value) if value == MFMediaType_Video => "MFMediaType_Video".into(),
        Some(value) if value == MFVideoFormat_H264 => "MFVideoFormat_H264".into(),
        Some(value) if value == MFVideoFormat_NV12 => "MFVideoFormat_NV12".into(),
        Some(value) => format!("{value:?}"),
        None => "missing".into(),
    }
}

fn blob_summary(
    media: &windows::Win32::Media::MediaFoundation::IMFMediaType,
    key: &GUID,
) -> String {
    unsafe {
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if media.GetAllocatedBlob(key, &mut ptr, &mut len).is_err() || ptr.is_null() {
            return "missing".into();
        }
        let bytes = std::slice::from_raw_parts(ptr, len as usize);
        let preview: String = bytes
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        CoTaskMemFree(Some(ptr as *const std::ffi::c_void));
        format!("len={len} head={preview}")
    }
}

pub(super) fn stop_boundary(boundary: &str, detail: &str) -> String {
    tracing::error!(
        gpu_dxgi_first_failing_boundary = boundary,
        detail,
        "gpu_dxgi first failing boundary isolated; GPU compose stopping"
    );
    format!("gpu_dxgi_first_failing_boundary={boundary} {detail}")
}

pub(super) fn hr_from_detail(detail: &str) -> String {
    detail
        .split_whitespace()
        .find(|part| part.starts_with("wrap_hr=") || part.starts_with("write_hr="))
        .map(|part| part.split('=').nth(1).unwrap_or(part).to_string())
        .unwrap_or_else(|| detail.to_string())
}

pub(super) fn dump_texture(
    label: &str,
    texture: &ID3D11Texture2D,
    gpu: &SharedGpu,
    subresource: u32,
    dest_w: u32,
    dest_h: u32,
) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let tex_device = texture_device(texture);
    let tex_device_ptr = tex_device.as_ref().map(raw_ptr);
    let shared_ptr = raw_ptr(&gpu.device);
    let format_nv12 = desc.Format == DXGI_FORMAT_NV12;
    let same_device = tex_device_ptr == Some(shared_ptr);
    let same_dims = desc.Width == dest_w && desc.Height == dest_h;
    let encoder_bind = desc.BindFlags == 0 && desc.Usage == D3D11_USAGE_DEFAULT;
    let vp_bind =
        desc.BindFlags == (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
    tracing::info!(
        label,
        format = format_name(desc.Format),
        format_nv12,
        width = desc.Width,
        height = desc.Height,
        dest = format!("{dest_w}x{dest_h}"),
        same_dimensions = same_dims,
        mips = desc.MipLevels,
        array = desc.ArraySize,
        usage = desc.Usage.0,
        bind_flags = format!("{:#x}", desc.BindFlags),
        cpu_access = desc.CPUAccessFlags,
        misc_flags = desc.MiscFlags,
        sample_count = desc.SampleDesc.Count,
        subresource,
        subresource_ok = subresource == 0,
        texture = format!("{:#x}", raw_ptr(texture)),
        texture_device = tex_device_ptr.map(|ptr| format!("{ptr:#x}")).unwrap_or_else(|| "unavailable".into()),
        shared_device = format!("{shared_ptr:#x}"),
        same_device,
        encoder_typical_bind = encoder_bind,
        vp_output_bind = vp_bind,
        assert_format_nv12 = format_nv12,
        assert_dims_match_encoder = same_dims,
        assert_same_d3d_device = same_device,
        assert_no_cpu_map = desc.CPUAccessFlags == 0,
        adapter = %gpu.adapter,
        adapter_luid = %adapter_luid(&gpu.device),
        "DXGI texture dump"
    );
}

pub(super) fn dump_wrapped_sample(
    label: &str,
    buffer: &IMFMediaBuffer,
    sample: &IMFSample,
    texture: &ID3D11Texture2D,
    expected_subresource: u32,
    gpu: &SharedGpu,
    dest_w: u32,
    dest_h: u32,
) {
    let time = unsafe { sample.GetSampleTime().ok() };
    let duration = unsafe { sample.GetSampleDuration().ok() };
    let buffer_count = unsafe { sample.GetBufferCount().ok() };
    let keyframe = unsafe { sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) } != 0;
    let time_ok = time.is_some_and(|value| value >= 0);
    let duration_ok = duration.is_some_and(|value| value > 0);
    let dxgi = buffer.cast::<IMFDXGIBuffer>();
    let (wrapped_tex, wrapped_sub, wrap_ok) = match &dxgi {
        Ok(dxgi) => match dxgi_texture(dxgi) {
            Ok(wrapped) => {
                let sub = unsafe { dxgi.GetSubresourceIndex().unwrap_or(u32::MAX) };
                let same_tex = raw_ptr(&wrapped) == raw_ptr(texture);
                tracing::info!(
                    label,
                    wrapped_texture = format!("{:#x}", raw_ptr(&wrapped)),
                    source_texture = format!("{:#x}", raw_ptr(texture)),
                    same_texture = same_tex,
                    wrapped_subresource = sub,
                    expected_subresource,
                    subresource_ok = sub == expected_subresource,
                    "IMFDXGIBuffer wrap"
                );
                dump_texture(
                    &format!("{label}_wrapped"),
                    &wrapped,
                    gpu,
                    sub,
                    dest_w,
                    dest_h,
                );
                (
                    Some(raw_ptr(&wrapped)),
                    Some(sub),
                    same_tex && sub == expected_subresource,
                )
            }
            Err(err) => {
                tracing::warn!(label, %err, "IMFDXGIBuffer GetResource failed");
                (None, None, false)
            }
        },
        Err(err) => {
            tracing::warn!(
                label,
                hr = format!("{:#x}", err.code().0 as u32),
                %err,
                "wrapped buffer is not IMFDXGIBuffer"
            );
            (None, None, false)
        }
    };
    tracing::info!(
        label,
        sample_time = time,
        sample_duration = duration,
        buffer_count,
        keyframe,
        assert_time_non_negative = time_ok,
        assert_duration_positive = duration_ok,
        assert_imfdxgi_buffer = dxgi.is_ok(),
        assert_no_cpu_map = true,
        wrapped_ok = wrap_ok,
        wrapped_texture = wrapped_tex.map(|ptr| format!("{ptr:#x}")),
        wrapped_subresource = wrapped_sub,
        "DXGI sample timestamp and duration"
    );
}

pub(super) fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value.trim() == "1")
}

pub(super) fn surface_probe_mode() -> Option<char> {
    match std::env::var("REPLAYR_GPU_SURFACE_PROBE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("A") | Some("a") => Some('A'),
        Some("B") | Some("b") => Some('B'),
        Some("C") | Some("c") => Some('C'),
        _ => None,
    }
}

pub(super) fn log_surface_transition(
    frame: u64,
    hop: &str,
    texture: Option<&ID3D11Texture2D>,
    subresource: u32,
    ring_slot: i64,
    decoder_slice: u32,
    hr: &str,
) -> SurfaceHop {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    let (ptr, format, width, height, bind, array, mips, device) = if let Some(tex) = texture {
        unsafe { tex.GetDesc(&mut desc) };
        let device = texture_device(tex)
            .as_ref()
            .map(|dev| format!("{:#x}", raw_ptr(dev)))
            .unwrap_or_else(|| "unavailable".into());
        (
            format!("{:#x}", raw_ptr(tex)),
            format_name(desc.Format),
            desc.Width,
            desc.Height,
            format!("{:#x}", desc.BindFlags),
            desc.ArraySize,
            desc.MipLevels,
            device,
        )
    } else {
        (
            "none".into(),
            "n/a".into(),
            0,
            0,
            "n/a".into(),
            0,
            0,
            "n/a".into(),
        )
    };
    tracing::info!(
        frame_index = frame,
        hop,
        texture_ptr = %ptr,
        subresource,
        dxgi_format = %format,
        width,
        height,
        bind_flags = %bind,
        array_size = array,
        mip_levels = mips,
        device_ptr = %device,
        ring_slot,
        decoder_slice,
        hr,
        "surface transition"
    );
    SurfaceHop {
        hop: hop.into(),
        texture: ptr,
        subresource,
        format,
        width,
        height,
        bind_flags: bind,
        array_size: array,
        mip_levels: mips,
        device,
        ring_slot,
        decoder_slice,
        hr: hr.into(),
    }
}

pub(super) fn compare_surface_hops(prev_frame: u64, prev: &[SurfaceHop], curr_frame: u64, curr: &[SurfaceHop]) {
    let mut first_diff: Option<String> = None;
    for hop in curr {
        let Some(was) = prev.iter().find(|p| p.hop == hop.hop) else {
            tracing::info!(
                hop = %hop.hop,
                curr_frame,
                "surface hop missing on known-good frame"
            );
            if first_diff.is_none() {
                first_diff = Some(format!("{} (missing on frame {prev_frame})", hop.hop));
            }
            continue;
        };
        let mut diffs = Vec::new();
        if hop.subresource != was.subresource {
            diffs.push(format!(
                "subresource {} -> {}",
                was.subresource, hop.subresource
            ));
        }
        if hop.format != was.format {
            diffs.push(format!("format {} -> {}", was.format, hop.format));
        }
        if hop.width != was.width || hop.height != was.height {
            diffs.push(format!(
                "size {}x{} -> {}x{}",
                was.width, was.height, hop.width, hop.height
            ));
        }
        if hop.bind_flags != was.bind_flags {
            diffs.push(format!("bind {} -> {}", was.bind_flags, hop.bind_flags));
        }
        if hop.array_size != was.array_size {
            diffs.push(format!("array {} -> {}", was.array_size, hop.array_size));
        }
        if hop.mip_levels != was.mip_levels {
            diffs.push(format!("mips {} -> {}", was.mip_levels, hop.mip_levels));
        }
        if hop.device != was.device {
            diffs.push(format!("device {} -> {}", was.device, hop.device));
        }
        if hop.hr != was.hr {
            diffs.push(format!("hr {} -> {}", was.hr, hop.hr));
        }
        let ptr_changed = hop.texture != was.texture;
        let slot_changed = hop.ring_slot != was.ring_slot;
        let slice_changed = hop.decoder_slice != was.decoder_slice;
        if !diffs.is_empty() && first_diff.is_none() {
            first_diff = Some(format!("{} [{}]", hop.hop, diffs.join(", ")));
        }
        tracing::info!(
            hop = %hop.hop,
            prev_frame,
            curr_frame,
            texture_changed = ptr_changed,
            prev_texture = %was.texture,
            curr_texture = %hop.texture,
            ring_slot_changed = slot_changed,
            prev_ring_slot = was.ring_slot,
            curr_ring_slot = hop.ring_slot,
            decoder_slice_changed = slice_changed,
            prev_decoder_slice = was.decoder_slice,
            curr_decoder_slice = hop.decoder_slice,
            metadata_diffs = diffs.join("; "),
            "surface hop compare vs known-good"
        );
    }
    match first_diff {
        Some(diff) => tracing::warn!(
            first_differing_surface = %diff,
            prev_frame,
            curr_frame,
            "first surface that differs from known-good frame"
        ),
        None => tracing::info!(
            prev_frame,
            curr_frame,
            "no metadata difference vs known-good frame (texture/slot/slice rotation expected)"
        ),
    }
}