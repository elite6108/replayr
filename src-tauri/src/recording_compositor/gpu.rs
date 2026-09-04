//! Recording-only D3D11 device. Not shared with clip export GPU code.

#![cfg(windows)]

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Asynchronous, ID3D11Device, ID3D11DeviceContext, ID3D11Query,
    ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER, D3D11_CPU_ACCESS_WRITE,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_QUERY_DESC,
    D3D11_QUERY_EVENT, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};

use std::thread;
use std::time::{Duration, Instant};

const QUERY_WAIT: Duration = Duration::from_secs(2);
const QUERY_POLL: Duration = Duration::from_micros(200);

pub struct SharedGpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub video: ID3D11VideoDevice,
    pub video_ctx: ID3D11VideoContext,
    pub manager: IMFDXGIDeviceManager,
    pub adapter: String,
}

pub struct GpuEvent {
    query: ID3D11Query,
}

impl GpuEvent {
    pub fn create(device: &ID3D11Device) -> Result<Self, String> {
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

    pub fn end(&self, context: &ID3D11DeviceContext) {
        if let Ok(async_q) = self.query.cast::<ID3D11Asynchronous>() {
            unsafe { context.End(&async_q) };
        }
    }

    pub fn wait(&self, gpu: &SharedGpu) -> Result<(), String> {
        self.wait_on(&gpu.context, QUERY_WAIT)
    }

    pub fn wait_on(&self, context: &ID3D11DeviceContext, timeout: Duration) -> Result<(), String> {
        let async_q: ID3D11Asynchronous = self
            .query
            .cast()
            .map_err(|err| format!("event query is not ID3D11Asynchronous: {err}"))?;
        let started = Instant::now();
        loop {
            match unsafe { context.GetData(&async_q, None, 0, 0) } {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let hr = err.code().0 as u32;
                    if hr != 1 && hr != 0x887A000A {
                        return Err(format!("D3D11 GetData failed: {err}"));
                    }
                }
            }
            if started.elapsed() > timeout {
                return Err("GPU compose timed out.".into());
            }
            thread::sleep(QUERY_POLL);
        }
    }
}

impl SharedGpu {
    pub fn open() -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
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
            let device = device.ok_or_else(|| "D3D11 compose device was empty.".to_string())?;
            let context = context.ok_or_else(|| "D3D11 compose context was empty.".to_string())?;
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
            Ok(Self {
                adapter: adapter_name(&device),
                device,
                context,
                video,
                video_ctx,
                manager,
            })
        }
    }

    pub fn check_device(&self) -> Result<(), String> {
        match unsafe { self.device.GetDeviceRemovedReason() } {
            Ok(()) => Ok(()),
            Err(err) => {
                let hr = err.code().0 as u32;
                let kind = match hr {
                    0x887A0005 => "removed",
                    0x887A0006 => "hung",
                    0x887A0007 => "reset",
                    _ => "lost",
                };
                let _ = err;
                Err(format!(
                    "The GPU was {kind} during composed recording. The session stopped."
                ))
            }
        }
    }
}

pub fn create_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    bind: u32,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(2),
        Height: height.max(2),
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|err| format!("Could not create a {width}x{height} GPU texture: {err}"))?;
    }
    texture.ok_or_else(|| format!("{width}x{height} GPU texture was empty."))
}

pub fn create_nv12_output(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    create_texture(device, width, height, DXGI_FORMAT_NV12, bind)
}

/// Same descriptor as the proven `gpu_dxgi` VideoProcessor output / encoder input.
pub fn create_nv12_encode(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    create_texture(device, width, height, DXGI_FORMAT_NV12, bind)
}

pub fn create_bgra_input(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
    create_texture(device, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, bind)
}

pub fn upload_bgra(
    gpu: &SharedGpu,
    dest: &ID3D11Texture2D,
    pixels: &[u8],
    width: u32,
    height: u32,
    pitch: u32,
) -> Result<(), String> {
    let expected = pitch as usize * height as usize;
    if pixels.len() < expected || width == 0 || height == 0 {
        return Err("Capture frame was empty.".into());
    }
    let resource: ID3D11Resource = dest
        .cast()
        .map_err(|err| format!("Could not upload a compose layer: {err}"))?;
    unsafe {
        gpu.context.UpdateSubresource(
            &resource,
            0,
            None,
            pixels.as_ptr() as *const _,
            pitch,
            0,
        );
    }
    let _ = D3D11_USAGE_DYNAMIC;
    let _ = D3D11_CPU_ACCESS_WRITE;
    let _ = D3D11_SUBRESOURCE_DATA::default();
    Ok(())
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
