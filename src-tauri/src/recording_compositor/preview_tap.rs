//! Observational composed-output tap. Disposable. Never owns encoder surfaces.
//!
//! Record thread may GPU-blit and enqueue. It must not Map, PNG, base64, or wait.

#![cfg(windows)]

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
    D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_TEX2D_VPIV,
    D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};

use crate::preview::PreviewHub;

use super::compositor::RecordingCompositor;

pub const PREVIEW_WIDTH: u32 = 960;
pub const PREVIEW_HEIGHT: u32 = 540;
const PREVIEW_INTERVAL: Duration = Duration::from_millis(33);

/// Marks PreviewHub composed-live for the recording session. Always clears on drop
/// so a failed encoder start can resume standalone preview.
struct ComposedPreviewLive {
    hub: PreviewHub,
}

impl ComposedPreviewLive {
    fn arm(hub: &PreviewHub) -> Self {
        hub.mark_composed_live(true);
        Self { hub: hub.clone() }
    }
}

impl Drop for ComposedPreviewLive {
    fn drop(&mut self) {
        self.hub.mark_composed_live(false);
    }
}

/// Worker tap plus composed-live flag. The tap is dropped first so Map/PNG
/// finish before standalone preview is allowed to resume.
pub struct ActiveComposedPreview {
    tap: ComposedPreviewTap,
    _live: ComposedPreviewLive,
}

impl ActiveComposedPreview {
    pub fn open(compositor: &RecordingCompositor, hub: PreviewHub) -> Result<Self, String> {
        let tap = ComposedPreviewTap::open(compositor, hub.clone())?;
        Ok(Self {
            tap,
            _live: ComposedPreviewLive::arm(&hub),
        })
    }

    pub fn try_offer(&mut self, compositor: &RecordingCompositor, hub: &PreviewHub) {
        self.tap.try_offer(compositor, hub);
    }
}

pub struct ComposedPreviewTap {
    shared: Arc<SharedTap>,
    worker: Option<JoinHandle<()>>,
    last_offer: Instant,
}

struct SharedTap {
    stop: AtomicBool,
    in_flight: AtomicBool,
    requested: AtomicU64,
    generated: AtomicU64,
    dropped: AtomicU64,
    pending: Mutex<bool>,
    cv: Condvar,
    context: ID3D11DeviceContext,
    video: ID3D11VideoDevice,
    video_ctx: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    dest: ID3D11Texture2D,
    dest_view: ID3D11VideoProcessorOutputView,
    staging: ID3D11Texture2D,
    src_view: Mutex<Option<ID3D11VideoProcessorInputView>>,
}

impl ComposedPreviewTap {
    pub fn open(compositor: &RecordingCompositor, hub: PreviewHub) -> Result<Self, String> {
        let gpu = compositor.gpu();
        let dest = create_bgra(
            &gpu.device,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
            D3D11_USAGE_DEFAULT,
            D3D11_BIND_RENDER_TARGET.0 as u32,
            0,
        )?;
        let staging = create_bgra(
            &gpu.device,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
            D3D11_USAGE_STAGING,
            0,
            D3D11_CPU_ACCESS_READ.0 as u32,
        )?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: 60,
                Denominator: 1,
            },
            InputWidth: compositor.out_w.max(2),
            InputHeight: compositor.out_h.max(2),
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: 30,
                Denominator: 1,
            },
            OutputWidth: PREVIEW_WIDTH,
            OutputHeight: PREVIEW_HEIGHT,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumerator = unsafe {
            gpu.video
                .CreateVideoProcessorEnumerator(&desc)
                .map_err(|err| format!("preview enumerator: {err}"))?
        };
        let processor = unsafe {
            gpu.video
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|err| format!("preview processor: {err}"))?
        };
        let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut dest_view = None;
        unsafe {
            gpu.video
                .CreateVideoProcessorOutputView(&dest, &enumerator, &view_desc, Some(&mut dest_view))
                .map_err(|err| format!("preview output view: {err}"))?;
        }
        let dest_view = dest_view.ok_or_else(|| "preview output view was empty".to_string())?;
        unsafe {
            gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            gpu.video_ctx
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
        }
        let shared = Arc::new(SharedTap {
            stop: AtomicBool::new(false),
            in_flight: AtomicBool::new(false),
            requested: AtomicU64::new(0),
            generated: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            pending: Mutex::new(false),
            cv: Condvar::new(),
            context: gpu.context.clone(),
            video: gpu.video.clone(),
            video_ctx: gpu.video_ctx.clone(),
            enumerator,
            processor,
            dest,
            dest_view,
            staging,
            src_view: Mutex::new(None),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("composed-preview".into())
            .spawn(move || readback_loop(worker_shared, hub))
            .ok();
        Ok(Self {
            shared,
            worker,
            last_offer: Instant::now() - PREVIEW_INTERVAL,
        })
    }

    /// GPU blit + enqueue only. Drops if a preview job is already in flight.
    pub fn try_offer(&mut self, compositor: &RecordingCompositor, hub: &PreviewHub) {
        if !hub.wanted() {
            return;
        }
        if self.last_offer.elapsed() < PREVIEW_INTERVAL {
            return;
        }
        self.shared.requested.fetch_add(1, Ordering::Relaxed);
        if self.shared.in_flight.load(Ordering::SeqCst) {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if blit_preview(&self.shared, compositor).is_err() {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        copy_to_staging(&self.shared);
        unsafe { self.shared.context.Flush() };
        self.shared.in_flight.store(true, Ordering::SeqCst);
        if let Ok(mut pending) = self.shared.pending.lock() {
            *pending = true;
        }
        self.shared.cv.notify_one();
        self.last_offer = Instant::now();
    }

    pub fn log_stats(&self) {
        tracing::info!(
            preview_frames_requested = self.shared.requested.load(Ordering::Relaxed),
            preview_frames_generated = self.shared.generated.load(Ordering::Relaxed),
            preview_frames_dropped = self.shared.dropped.load(Ordering::Relaxed),
            preview_resolution = format!("{}x{}", PREVIEW_WIDTH, PREVIEW_HEIGHT),
            "composed preview tap"
        );
    }
}

impl Drop for ComposedPreviewTap {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.cv.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.log_stats();
    }
}

fn blit_preview(shared: &SharedTap, compositor: &RecordingCompositor) -> Result<(), String> {
    let src = compositor.composed_nv12();
    let mut slot = shared
        .src_view
        .lock()
        .map_err(|_| "preview view lock".to_string())?;
    if slot.is_none() {
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };
        let mut view = None;
        unsafe {
            shared
                .video
                .CreateVideoProcessorInputView(src, &shared.enumerator, &desc, Some(&mut view))
                .map_err(|err| format!("preview input view: {err}"))?;
        }
        *slot = Some(view.ok_or_else(|| "preview input view was empty".to_string())?);
    }
    let view = slot.as_ref().ok_or_else(|| "preview input view missing".to_string())?;
    let dest = RECT {
        left: 0,
        top: 0,
        right: PREVIEW_WIDTH as i32,
        bottom: PREVIEW_HEIGHT as i32,
    };
    let src_rect = RECT {
        left: 0,
        top: 0,
        right: compositor.out_w as i32,
        bottom: compositor.out_h as i32,
    };
    unsafe {
        shared.video_ctx.VideoProcessorSetStreamSourceRect(
            &shared.processor,
            0,
            true,
            Some(&src_rect as *const RECT),
        );
        shared.video_ctx.VideoProcessorSetStreamDestRect(
            &shared.processor,
            0,
            true,
            Some(&dest as *const RECT),
        );
        let streams = [D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: BOOL(1),
            pInputSurface: ManuallyDrop::new(Some(view.clone())),
            ..Default::default()
        }];
        let blt = shared.video_ctx.VideoProcessorBlt(
            &shared.processor,
            &shared.dest_view,
            0,
            &streams,
        );
        drop(ManuallyDrop::into_inner(std::ptr::read(
            &streams[0].pInputSurface,
        )));
        blt.map_err(|err| format!("preview blit: {err}"))?;
    }
    Ok(())
}

fn copy_to_staging(shared: &SharedTap) {
    let Ok(src) = shared.dest.cast::<ID3D11Resource>() else {
        return;
    };
    let Ok(dst) = shared.staging.cast::<ID3D11Resource>() else {
        return;
    };
    unsafe {
        shared
            .context
            .CopySubresourceRegion(&dst, 0, 0, 0, 0, &src, 0, None);
    }
}

fn readback_loop(shared: Arc<SharedTap>, hub: PreviewHub) {
    while !shared.stop.load(Ordering::SeqCst) {
        let Ok(mut pending) = shared.pending.lock() else {
            break;
        };
        while !*pending && !shared.stop.load(Ordering::SeqCst) {
            pending = match shared.cv.wait_timeout(pending, Duration::from_millis(100)) {
                Ok((guard, _)) => guard,
                Err(_) => return,
            };
        }
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        *pending = false;
        drop(pending);
        if let Some(frame) = map_staging(&shared) {
            hub.offer(&frame);
            shared.generated.fetch_add(1, Ordering::Relaxed);
        } else {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
        shared.in_flight.store(false, Ordering::SeqCst);
    }
}

fn map_staging(shared: &SharedTap) -> Option<crate::still::StillFrame> {
    let resource: ID3D11Resource = shared.staging.cast().ok()?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        shared
            .context
            .Map(&resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .ok()?;
    }
    let pitch = mapped.RowPitch;
    let size = pitch.saturating_mul(PREVIEW_HEIGHT) as usize;
    let mut bgra = vec![0_u8; size];
    if size > 0 && !mapped.pData.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(mapped.pData as *const u8, bgra.as_mut_ptr(), size);
        }
    }
    unsafe { shared.context.Unmap(&resource, 0) };
    Some(crate::still::StillFrame {
        bgra,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        pitch,
    })
}

fn create_bgra(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE,
    bind: u32,
    cpu: u32,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(2),
        Height: height.max(2),
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: usage,
        BindFlags: bind,
        CPUAccessFlags: cpu,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|err| format!("preview texture: {err}"))?;
    }
    texture.ok_or_else(|| "preview texture was empty".to_string())
}
