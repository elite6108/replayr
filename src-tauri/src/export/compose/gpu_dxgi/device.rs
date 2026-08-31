use std::thread;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Asynchronous, ID3D11Device, ID3D11DeviceContext, ID3D11InfoQueue,
    ID3D11Query, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
    D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BIND_VIDEO_ENCODER, D3D11_BOX, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MESSAGE,
    D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter3, IDXGIDevice, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
};
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};

use super::BOUNDARY_LOG_FROM;

pub(super) const QUERY_WAIT: Duration = Duration::from_secs(2);
const QUERY_POLL: Duration = Duration::from_micros(200);

pub(super) struct SharedGpu {
    pub(super) device: ID3D11Device,
    pub(super) context: ID3D11DeviceContext,
    pub(super) video: ID3D11VideoDevice,
    pub(super) video_ctx: ID3D11VideoContext,
    pub(super) manager: IMFDXGIDeviceManager,
    pub(super) adapter: String,
    pub(super) reset_token: u32,
    pub(super) info_queue: Option<ID3D11InfoQueue>,
}

pub(super) struct GpuEvent {
    query: ID3D11Query,
}

impl GpuEvent {
    pub(super) fn create(device: &ID3D11Device) -> Result<Self, String> {
        let desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut query = None;
        unsafe {
            device
                .CreateQuery(&desc, Some(&mut query))
                .map_err(|err| format!("Could not create a D3D11 event query: {err}"))?;
        }
        Ok(Self {
            query: query.ok_or_else(|| "D3D11 event query was empty.".to_string())?,
        })
    }

    pub(super) fn end(&self, context: &ID3D11DeviceContext) -> Result<(), String> {
        let async_q: ID3D11Asynchronous = self
            .query
            .cast()
            .map_err(|err| format!("event query is not ID3D11Asynchronous: {err}"))?;
        unsafe { context.End(&async_q) };
        Ok(())
    }

    fn ready(&self, gpu: &SharedGpu) -> Result<bool, String> {
        let async_q: ID3D11Asynchronous = self
            .query
            .cast()
            .map_err(|err| format!("event query is not ID3D11Asynchronous: {err}"))?;
        match unsafe {
            gpu.context
                .GetData(&async_q, None, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32)
        } {
            Ok(()) => Ok(true),
            Err(err) => {
                let hr = err.code().0 as u32;
                if hr == 1 || hr == 0x887A000A {
                    Ok(false)
                } else {
                    Err(gpu_fail(
                        gpu,
                        "GetData",
                        hr,
                        &GpuFailDiag::default(),
                    ))
                }
            }
        }
    }

    pub(super) fn wait(&self, gpu: &SharedGpu, diag: &GpuFailDiag) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if self.ready(gpu)? {
                return Ok(());
            }
            if started.elapsed() > QUERY_WAIT {
                return Err(gpu_fail(gpu, "query_wait_timeout", 0x887A0006, diag));
            }
            thread::sleep(QUERY_POLL);
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct GpuFailDiag {
    pub(super) frame: u64,
    pub(super) encoded: u64,
    pub(super) in_flight: u64,
    pub(super) input_slot: usize,
    pub(super) output_slot: usize,
    pub(super) decoder_slice: u32,
    pub(super) input_ring_busy: u32,
    pub(super) output_ring_busy: u32,
    pub(super) decoder_slices_referenced: u32,
    pub(super) encoder_in_flight: u32,
    pub(super) vp_input_views: u32,
    pub(super) vp_output_views: u32,
    pub(super) outstanding_input_samples: u32,
    pub(super) outstanding_output_samples: u32,
}

fn dxgi_reason_name(hr: u32) -> &'static str {
    match hr {
        0x00000000 => "S_OK",
        0x00000001 => "S_FALSE",
        0x8007000E => "E_OUTOFMEMORY",
        0x80070057 => "E_INVALIDARG",
        0x887A0001 => "DXGI_ERROR_INVALID_CALL",
        0x887A0005 => "DXGI_ERROR_DEVICE_REMOVED",
        0x887A0006 => "DXGI_ERROR_DEVICE_HUNG",
        0x887A0007 => "DXGI_ERROR_DEVICE_RESET",
        0x887A000A => "DXGI_ERROR_WAS_STILL_DRAWING",
        0x887A0020 => "DXGI_ERROR_DRIVER_INTERNAL_ERROR",
        _ => "UNKNOWN",
    }
}

pub(super) fn device_removed_reason(gpu: &SharedGpu) -> (u32, &'static str) {
    match unsafe { gpu.device.GetDeviceRemovedReason() } {
        Ok(()) => (0, "S_OK"),
        Err(err) => {
            let hr = err.code().0 as u32;
            (hr, dxgi_reason_name(hr))
        }
    }
}

pub(super) fn gpu_fail(gpu: &SharedGpu, op: &str, original_hr: u32, diag: &GpuFailDiag) -> String {
    let (removed_hr, removed_name) = device_removed_reason(gpu);
    tracing::error!(
        op,
        original_hr = format!("{original_hr:#x}"),
        original_name = dxgi_reason_name(original_hr),
        device_removed_hr = format!("{removed_hr:#x}"),
        device_removed_name = removed_name,
        frame_index = diag.frame,
        input_ring_slot = diag.input_slot,
        output_ring_slot = diag.output_slot,
        decoder_array_slice = diag.decoder_slice,
        encoded = diag.encoded,
        in_flight = diag.in_flight,
        outstanding_input_samples = diag.outstanding_input_samples,
        outstanding_output_samples = diag.outstanding_output_samples,
        input_ring_busy = diag.input_ring_busy,
        output_ring_busy = diag.output_ring_busy,
        decoder_slices_referenced = diag.decoder_slices_referenced,
        encoder_in_flight = diag.encoder_in_flight,
        vp_input_views_alive = diag.vp_input_views,
        vp_output_views_alive = diag.vp_output_views,
        cpu_map_count = 0,
        "gpu_dxgi device-removal diagnostics"
    );
    format!(
        "gpu_dxgi {op} hr={original_hr:#x} ({}) device_removed={removed_hr:#x} ({removed_name}) frame={} in={} out={} slice={} encoded={} in_flight={}",
        dxgi_reason_name(original_hr),
        diag.frame,
        diag.input_slot,
        diag.output_slot,
        diag.decoder_slice,
        diag.encoded,
        diag.in_flight
    )
}

impl SharedGpu {
    pub(super) fn open() -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            let debug_hr = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                flags | D3D11_CREATE_DEVICE_DEBUG,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            let debug_layer = debug_hr.is_ok() && device.is_some() && context.is_some();
            if !debug_layer {
                device = None;
                context = None;
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    Default::default(),
                    flags,
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
                .map_err(|err| format!("Could not create a D3D11 compose device: {err}"))?;
            }
            let device = device.ok_or_else(|| "D3D11 compose device was empty.".to_string())?;
            let context = context.ok_or_else(|| "D3D11 compose context was empty.".to_string())?;
            let info_queue = device.cast::<ID3D11InfoQueue>().ok();
            if let Some(queue) = &info_queue {
                let _ = queue.SetMessageCountLimit(4096);
            }
            tracing::info!(
                d3d11_debug_layer = debug_layer,
                info_queue = info_queue.is_some(),
                "D3D11 device created"
            );
            if let Ok(mt) = device.cast::<ID3D10Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }
            let video: ID3D11VideoDevice = device
                .cast()
                .map_err(|err| format!("This GPU has no D3D11 video processor: {err}"))?;
            let video_ctx: ID3D11VideoContext = context
                .cast()
                .map_err(|err| format!("This GPU has no D3D11 video context: {err}"))?;
            let mut reset_token = 0_u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
                .map_err(|err| format!("Could not create the DXGI device manager: {err}"))?;
            let manager = manager.ok_or_else(|| "DXGI device manager was empty.".to_string())?;
            manager
                .ResetDevice(&device, reset_token)
                .map_err(|err| format!("Could not bind the DXGI device manager: {err}"))?;
            tracing::info!(
                reset_token,
                reset_device_hr = "0x0",
                device = format!("{:#x}", device.as_raw() as usize),
                manager = format!("{:#x}", manager.as_raw() as usize),
                "IMFDXGIDeviceManager ResetDevice succeeded"
            );
            let adapter = adapter_name(&device);
            Ok(Self {
                device,
                context,
                video,
                video_ctx,
                manager,
                adapter,
                reset_token,
                info_queue,
            })
        }
    }
}

fn adapter_name(device: &ID3D11Device) -> String {
    unsafe {
        let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
            return "D3D11".into();
        };
        let Ok(adapter) = dxgi.GetAdapter() else {
            return "D3D11".into();
        };
        let Ok(desc) = adapter.GetDesc() else {
            return "D3D11".into();
        };
        let end = desc
            .Description
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(desc.Description.len());
        String::from_utf16_lossy(&desc.Description[..end])
    }
}

pub(super) fn log_shared_device(gpu: &SharedGpu) {
    let device_ptr = raw_ptr(&gpu.device);
    let manager_ptr = manager_device_ptr(&gpu.manager);
    let luid = adapter_luid(&gpu.device);
    tracing::info!(
        adapter = %gpu.adapter,
        adapter_luid = %luid,
        shared_device = format!("{device_ptr:#x}"),
        manager_device = manager_ptr.map(|ptr| format!("{ptr:#x}")).unwrap_or_else(|| "unavailable".into()),
        same_device = manager_ptr == Some(device_ptr),
        "shared D3D device identity"
    );
}

pub(super) fn create_blank_nv12(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    bind_flags: u32,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind_flags,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|err| {
                format!("Could not create blank {width}x{height} NV12 texture: {err}")
            })?;
    }
    texture.ok_or_else(|| format!("Blank {width}x{height} NV12 texture was empty."))
}

pub(super) fn texture_device(texture: &ID3D11Texture2D) -> Option<ID3D11Device> {
    unsafe { texture.GetDevice().ok() }
}

fn manager_device_ptr(manager: &IMFDXGIDeviceManager) -> Option<usize> {
    unsafe {
        let handle = manager.OpenDeviceHandle().ok()?;
        let mut raw = std::ptr::null_mut();
        let locked = manager
            .LockDevice(handle, &ID3D11Device::IID, &mut raw, false)
            .ok();
        let ptr = if locked.is_some() && !raw.is_null() {
            let device = ID3D11Device::from_raw(raw as *mut _);
            let ptr = raw_ptr(&device);
            Some(ptr)
        } else {
            None
        };
        let _ = manager.UnlockDevice(handle, false);
        let _ = manager.CloseDeviceHandle(handle);
        ptr
    }
}

pub(super) fn adapter_luid(device: &ID3D11Device) -> String {
    unsafe {
        let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
            return "unknown".into();
        };
        let Ok(adapter) = dxgi.GetAdapter() else {
            return "unknown".into();
        };
        let Ok(desc) = adapter.GetDesc() else {
            return "unknown".into();
        };
        format!(
            "{:08x}:{:08x}",
            desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
        )
    }
}

pub(super) fn vram_usage(device: &ID3D11Device) -> Option<(u64, u64, u64)> {
    unsafe {
        let dxgi = device.cast::<IDXGIDevice>().ok()?;
        let adapter = dxgi.GetAdapter().ok()?;
        let adapter3 = adapter.cast::<IDXGIAdapter3>().ok()?;
        let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
        adapter3
            .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
            .ok()?;
        Some((info.CurrentUsage, info.Budget, info.CurrentReservation))
    }
}

pub(super) fn drain_d3d_debug(gpu: &SharedGpu, frame: u64, at: &str) {
    let Some(queue) = &gpu.info_queue else {
        return;
    };
    unsafe {
        if frame < BOUNDARY_LOG_FROM {
            queue.ClearStoredMessages();
            return;
        }
        let count = queue.GetNumStoredMessages();
        if count == 0 {
            return;
        }
        for i in 0..count {
            let mut len = 0usize;
            let _ = queue.GetMessage(i, None, &mut len);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u8; len];
            let msg = buf.as_mut_ptr() as *mut D3D11_MESSAGE;
            if queue.GetMessage(i, Some(msg), &mut len).is_err() {
                continue;
            }
            let message = &*msg;
            let desc = if !message.pDescription.is_null() && message.DescriptionByteLength > 0 {
                let n = message.DescriptionByteLength.saturating_sub(1);
                std::string::String::from_utf8_lossy(std::slice::from_raw_parts(
                    message.pDescription,
                    n,
                ))
                .into_owned()
            } else {
                String::new()
            };
            tracing::warn!(
                frame_index = frame,
                at,
                severity = message.Severity.0,
                category = message.Category.0,
                id = message.ID.0,
                description = %desc,
                "D3D11 debug layer"
            );
        }
        queue.ClearStoredMessages();
    }
}

pub(super) fn gpu_copy_nv12_box(
    gpu: &SharedGpu,
    src: &ID3D11Texture2D,
    src_subresource: u32,
    dst_w: u32,
    dst_h: u32,
    diag: &GpuFailDiag,
) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    let dest = create_blank_nv12(&gpu.device, dst_w, dst_h, bind)?;
    let dst: ID3D11Resource = dest
        .cast()
        .map_err(|err| format!("probe dest cast hr={:#x}", err.code().0 as u32))?;
    let source: ID3D11Resource = src
        .cast()
        .map_err(|err| format!("probe src cast hr={:#x}", err.code().0 as u32))?;
    let region = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: dst_w,
        bottom: dst_h,
        back: 1,
    };
    unsafe {
        gpu.context
            .CopySubresourceRegion(&dst, 0, 0, 0, 0, &source, src_subresource, Some(&region));
    }
    let done = GpuEvent::create(&gpu.device)?;
    done.end(&gpu.context)?;
    unsafe { gpu.context.Flush() };
    done.wait(gpu, diag)?;
    Ok(dest)
}

pub(super) fn gpu_copy_full_nv12(
    gpu: &SharedGpu,
    src: &ID3D11Texture2D,
    dst_w: u32,
    dst_h: u32,
    diag: &GpuFailDiag,
) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    let dest = create_blank_nv12(&gpu.device, dst_w, dst_h, bind)?;
    let dst: ID3D11Resource = dest
        .cast()
        .map_err(|err| format!("probe dest cast hr={:#x}", err.code().0 as u32))?;
    let source: ID3D11Resource = src
        .cast()
        .map_err(|err| format!("probe src cast hr={:#x}", err.code().0 as u32))?;
    unsafe {
        gpu.context.CopyResource(&dst, &source);
    }
    let done = GpuEvent::create(&gpu.device)?;
    done.end(&gpu.context)?;
    unsafe { gpu.context.Flush() };
    done.wait(gpu, diag)?;
    Ok(dest)
}

pub(super) fn raw_ptr<T: Interface>(value: &T) -> usize {
    value.as_raw() as usize
}

pub(super) fn format_name(format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT) -> String {
    if format == DXGI_FORMAT_NV12 {
        "NV12".into()
    } else {
        format!("{:#x}", format.0)
    }
}