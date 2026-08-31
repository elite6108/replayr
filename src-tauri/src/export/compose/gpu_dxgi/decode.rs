use std::path::Path;

use windows::core::{Interface, GUID, PCWSTR};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Media::MediaFoundation::{
    IMFDXGIBuffer, IMFDXGIDeviceManager, IMFSample, IMFSourceReader, IMFSourceReaderEx,
    IMFTransform, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL,
    MFMediaType_Video, MFT_FRIENDLY_NAME_Attribute, MFVideoFormat_NV12, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_D3D_MANAGER,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

use super::device::format_name;

pub(super) struct DxgiFrame {
    /// Keeps the decoder array slice allocated until the owned-ring copy completes.
    #[allow(dead_code)]
    pub(super) sample: IMFSample,
    pub(super) texture: ID3D11Texture2D,
    pub(super) subresource: u32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) timestamp: i64,
    #[allow(dead_code)]
    pub(super) duration: i64,
}

pub(super) fn log_dxgi_format(label: &str, frame: &DxgiFrame) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    tracing::info!(
        stream = label,
        format = format_name(desc.Format),
        width = frame.width,
        height = frame.height,
        "VP input surface"
    );
}

pub(super) fn open_dxgi_reader(
    path: &Path,
    manager: &IMFDXGIDeviceManager,
) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create DXGI reader attributes.".to_string())?;
        attrs
            .SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, manager)
            .map_err(|err| format!("Could not attach DXGI to the decoder: {err}"))?;
        let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, false);
        let output = MFCreateMediaType().map_err(|err| err.to_string())?;
        output
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        output
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|err| err.to_string())?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &output)
            .map_err(|err| format!("DXGI decoder rejected NV12 for {}: {err}", path.display()))?;
        Ok(reader)
    }
}

pub(super) fn seek_hns(reader: &IMFSourceReader, position_hns: i64) -> Result<(), String> {
    unsafe {
        let position = PROPVARIANT::from(position_hns.max(0));
        reader
            .SetCurrentPosition(&GUID::zeroed(), &position)
            .map_err(|err| format!("Could not seek the DXGI reader: {err}"))?;
    }
    Ok(())
}

pub(super) fn read_dxgi_sample(reader: &IMFSourceReader) -> Result<Option<DxgiFrame>, String> {
    let mut flags = 0_u32;
    let mut timestamp = 0_i64;
    let mut sample: Option<IMFSample> = None;
    unsafe {
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
            .map_err(|err| format!("Could not read a DXGI sample: {err}"))?;
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    if flags != 0 {
        tracing::info!(flags = format!("{flags:#x}"), timestamp, "DXGI reader flags");
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let duration = unsafe { sample.GetSampleDuration().unwrap_or(0) }.max(10_000);
    let buffer = unsafe { sample.GetBufferByIndex(0).map_err(|err| err.to_string())? };
    let dxgi: IMFDXGIBuffer = buffer.cast().map_err(|_| {
        "Decoder did not return a DXGI surface; GPU compose cannot map the frame.".to_string()
    })?;
    let texture = dxgi_texture(&dxgi)?;
    let subresource = unsafe { dxgi.GetSubresourceIndex().unwrap_or(0) };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    if desc.Width == 0 || desc.Height == 0 {
        if let Ok(packed) = unsafe {
            reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .and_then(|media| media.GetUINT64(&MF_MT_FRAME_SIZE))
        } {
            desc.Width = (packed >> 32) as u32;
            desc.Height = packed as u32;
        }
    }
    Ok(Some(DxgiFrame {
        sample,
        texture,
        subresource,
        width: desc.Width,
        height: desc.Height,
        timestamp,
        duration,
    }))
}

pub(super) fn dxgi_texture(dxgi: &IMFDXGIBuffer) -> Result<ID3D11Texture2D, String> {
    unsafe {
        let mut raw = std::ptr::null_mut();
        dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)
            .map_err(|err| format!("Could not get the DXGI texture: {err}"))?;
        if raw.is_null() {
            return Err("DXGI buffer had no texture.".into());
        }
        Ok(ID3D11Texture2D::from_raw(raw as *mut _))
    }
}

pub(super) fn reader_transform_name(reader: &IMFSourceReader) -> Option<String> {
    unsafe {
        let ex: IMFSourceReaderEx = reader.cast().ok()?;
        let mut category = GUID::zeroed();
        let mut transform: Option<IMFTransform> = None;
        ex.GetTransformForStream(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            0,
            Some(&mut category as *mut _),
            &mut transform,
        )
        .ok()?;
        let transform = transform?;
        let attrs = transform.GetAttributes().ok()?;
        let mut pwstr = windows::core::PWSTR::null();
        let mut len = 0u32;
        attrs
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
            .ok()?;
        if pwstr.is_null() {
            return None;
        }
        let value = pwstr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

pub(super) fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}