//! GPU compose of ordered scene layers into one NV12 texture.

#![cfg(windows)]

use std::mem::ManuallyDrop;

use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Resource, ID3D11Texture2D, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_TEX2D_VPIV,
    D3D11_TEX2D_VPOV, D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0, D3D11_VIDEO_COLOR_YCbCrA,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CAPS,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL,
};

use crate::still::StillFrame;

use super::filters;
use super::gpu::{create_bgra_input, create_nv12_output, upload_bgra, GpuEvent, SharedGpu};
use super::nv12::align_output;
use super::scene::{
    ComposedFilterId, TextAlign, ValidatedComposition, ValidatedHud, ValidatedLayer,
};
use super::sources::image::{load_image, DecodedImage};
use super::sources::overlay::raster_filter_chrome;
use super::sources::text::{clamp_text_raster, raster_hud_line, raster_text};
use super::transforms::{contain_dest, cover_source, dest_rect, even_dim, FitMode, PixelRect};

const MAX_STREAMS: usize = 16;

struct LayerSlot {
    texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorInputView,
    width: u32,
    height: u32,
}

struct CachedStill {
    id: String,
    slot: LayerSlot,
    src_w: u32,
    src_h: u32,
}

pub struct RecordingCompositor {
    gpu: SharedGpu,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    sync: ID3D11Texture2D,
    capture: Option<LayerSlot>,
    webcam: Option<LayerSlot>,
    statics: Vec<CachedStill>,
    overlays: Vec<CachedStill>,
    hud: Vec<CachedStill>,
    max_streams: u32,
    pub out_w: u32,
    pub out_h: u32,
}

pub struct ComposeInput<'a> {
    pub capture: &'a StillFrame,
    pub webcam: Option<&'a StillFrame>,
}

struct BlitOp {
    view: ID3D11VideoProcessorInputView,
    dest: PixelRect,
    src: Option<PixelRect>,
    alpha: f32,
    capture: bool,
}

impl RecordingCompositor {
    pub fn open(gpu: SharedGpu, spec: &ValidatedComposition, first: &StillFrame) -> Result<Self, String> {
        let (out_w, out_h) = if spec.native_canvas {
            align_output(first.width, first.height)
        } else {
            align_output(spec.canvas_w, spec.canvas_h)
        };
        let fps = spec.fps;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            },
            InputWidth: first.width.max(2),
            InputHeight: first.height.max(2),
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            },
            OutputWidth: out_w,
            OutputHeight: out_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        unsafe {
            let enumerator = gpu
                .video
                .CreateVideoProcessorEnumerator(&desc)
                .map_err(|err| format!("Could not create the video processor enumerator: {err}"))?;
            let bgra_in = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32
                != 0;
            let nv12_out = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32
                != 0;
            if !bgra_in || !nv12_out {
                return Err(
                    "This GPU cannot compose BGRA capture into NV12. Use Legacy recording.".into(),
                );
            }
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            enumerator
                .GetVideoProcessorCaps(&mut caps)
                .map_err(|err| format!("Could not query video processor caps: {err}"))?;
            let max_streams = caps.MaxInputStreams.max(1).min(MAX_STREAMS as u32);
            if spec.layers.len() as u32 > max_streams {
                return Err("This GPU cannot composite that many recording sources. Remove a layer or use Legacy recording.".into());
            }
            let processor = gpu
                .video
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|err| format!("Could not create the video processor: {err}"))?;
            let output = create_nv12_output(&gpu.device, out_w, out_h)?;
            let sync = create_nv12_output(&gpu.device, out_w, out_h)?;
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            gpu.video
                .CreateVideoProcessorOutputView(&output, &enumerator, &view_desc, Some(&mut output_view))
                .map_err(|err| format!("Could not create the compose output view: {err}"))?;
            let output_view =
                output_view.ok_or_else(|| "Compose output view was empty.".to_string())?;
            for index in 0..max_streams {
                gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    index,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                gpu.video_ctx
                    .VideoProcessorSetStreamAutoProcessingMode(&processor, index, false);
            }
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 {
                    YCbCr: D3D11_VIDEO_COLOR_YCbCrA {
                        Y: 0.0,
                        Cb: 0.5,
                        Cr: 0.5,
                        A: 1.0,
                    },
                },
            };
            gpu.video_ctx
                .VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
            Ok(Self {
                gpu,
                enumerator,
                processor,
                output,
                output_view,
                sync,
                capture: None,
                webcam: None,
                statics: Vec::new(),
                overlays: Vec::new(),
                hud: Vec::new(),
                max_streams,
                out_w,
                out_h,
            })
        }
    }

    pub fn manager(&self) -> &windows::Win32::Media::MediaFoundation::IMFDXGIDeviceManager {
        &self.gpu.manager
    }

    pub fn adapter(&self) -> &str {
        &self.gpu.adapter
    }

    pub fn check_device(&self) -> Result<(), String> {
        self.gpu.check_device()
    }

    pub fn load_session_resources(&mut self, spec: &ValidatedComposition) -> Result<(), String> {
        self.statics.clear();
        for layer in &spec.layers {
            match layer {
                ValidatedLayer::Image(image) => {
                    let decoded = load_image(image)?;
                    self.cache_decoded(&decoded.id, &decoded)?;
                }
                ValidatedLayer::Text(text) => {
                    let dest = dest_rect(text.transform, self.out_w, self.out_h);
                    let (w, h) = clamp_text_raster(dest.w, dest.h, self.out_w, self.out_h);
                    let raster = raster_text(text, w, h)?;
                    self.cache_pixels(&raster.id, &raster.bgra, raster.width, raster.height)?;
                }
                ValidatedLayer::OverlayChrome { filter, .. } => {
                    for (index, bitmap) in raster_filter_chrome(*filter, self.out_w, self.out_h)
                        .into_iter()
                        .enumerate()
                    {
                        let slot = self.create_slot(bitmap.width, bitmap.height)?;
                        upload_bgra(
                            &self.gpu,
                            &slot.texture,
                            &bitmap.bgra,
                            bitmap.width,
                            bitmap.height,
                            bitmap.width * 4,
                        )?;
                        self.overlays.push(CachedStill {
                            id: format!("overlay-{index}-{}", bitmap.key),
                            src_w: bitmap.width,
                            src_h: bitmap.height,
                            slot,
                        });
                    }
                }
                ValidatedLayer::Capture | ValidatedLayer::Webcam => {}
            }
        }
        Ok(())
    }

    pub fn refresh_hud(&mut self, hud: &ValidatedHud, elapsed_ms: u64) -> Result<(), String> {
        self.hud.clear();
        if let Some(label) = hud.label.as_deref() {
            let raster = raster_hud_line(
                "hud-label",
                label,
                [220, 230, 220, 255],
                18,
                TextAlign::Left,
                (self.out_w / 4).max(120),
                36,
            )?;
            self.cache_hud(raster.id, raster.bgra, raster.width, raster.height)?;
        }
        if hud.rec {
            let raster = raster_hud_line(
                "hud-rec",
                "REC",
                [0xD0, 0xD0, 0xF2, 255],
                20,
                TextAlign::Right,
                120,
                36,
            )?;
            self.cache_hud(raster.id, raster.bgra, raster.width, raster.height)?;
        }
        if hud.timestamp {
            let stamp = wall_clock_stamp();
            let _ = elapsed_ms;
            let raster = raster_hud_line(
                "hud-clock",
                &stamp,
                [0xC8, 0xE4, 0xD7, 255],
                18,
                if hud.filter == ComposedFilterId::Dashcam {
                    TextAlign::Right
                } else {
                    TextAlign::Left
                },
                (self.out_w / 3).max(220),
                36,
            )?;
            self.cache_hud(raster.id, raster.bgra, raster.width, raster.height)?;
        }
        Ok(())
    }

    pub fn compose(
        &mut self,
        spec: &ValidatedComposition,
        input: ComposeInput<'_>,
    ) -> Result<&ID3D11Texture2D, String> {
        self.ensure_live_slot(false, input.capture)?;
        if let Some(slot) = self.capture.as_ref() {
            upload_bgra(
                &self.gpu,
                &slot.texture,
                &input.capture.bgra,
                input.capture.width,
                input.capture.height,
                input.capture.pitch,
            )?;
        }
        if let Some(cam) = input.webcam {
            self.ensure_live_slot(true, cam)?;
            if let Some(slot) = self.webcam.as_ref() {
                upload_bgra(
                    &self.gpu,
                    &slot.texture,
                    &cam.bgra,
                    cam.width,
                    cam.height,
                    cam.pitch,
                )?;
            }
        }

        let ops = self.collect_blits(spec, input.capture, input.webcam)?;
        if ops.len() as u32 > self.max_streams {
            return Err("Too many composed layers for this GPU.".into());
        }
        self.blt(spec, &ops)?;
        Ok(&self.output)
    }

    /// Composition pipeline (explicit, not accidental):
    ///
    /// 1. BASE CAPTURE (contain)
    /// 2. BASE FILTER on the capture stream only
    /// 3. SCENE SOURCES sorted by `order` (higher = in front): webcam, image, text
    /// 4. FILTER CHROME above all ordinary scene sources (matches Live Output Preview)
    /// 5. DYNAMIC HUD last
    fn collect_blits(
        &self,
        spec: &ValidatedComposition,
        capture: &StillFrame,
        webcam: Option<&StillFrame>,
    ) -> Result<Vec<BlitOp>, String> {
        let mut ops = Vec::new();
        for layer in &spec.layers {
            match layer {
                ValidatedLayer::Capture => {
                    let Some(slot) = self.capture.as_ref() else {
                        continue;
                    };
                    let dest = contain_dest(
                        capture.width,
                        capture.height,
                        dest_rect(spec.capture.transform, self.out_w, self.out_h),
                    );
                    ops.push(BlitOp {
                        view: slot.view.clone(),
                        dest,
                        src: None,
                        alpha: spec.capture.opacity,
                        capture: true,
                    });
                }
                ValidatedLayer::Webcam => {
                    let (Some(slot), Some(cam), Some(spec_cam)) =
                        (self.webcam.as_ref(), webcam, spec.webcam.as_ref())
                    else {
                        continue;
                    };
                    let dest = dest_rect(spec_cam.transform, self.out_w, self.out_h);
                    let src = cover_source(cam.width, cam.height, dest.w, dest.h);
                    ops.push(BlitOp {
                        view: slot.view.clone(),
                        dest,
                        src: Some(src),
                        alpha: spec_cam.opacity,
                        capture: false,
                    });
                }
                ValidatedLayer::Image(image) => {
                    let Some(cached) = self.statics.iter().find(|item| item.id == image.id) else {
                        continue;
                    };
                    let box_rect = dest_rect(image.transform, self.out_w, self.out_h);
                    let dest = match image.fit {
                        FitMode::Contain => contain_dest(cached.src_w, cached.src_h, box_rect),
                        FitMode::Cover => box_rect,
                        FitMode::Stretch => box_rect,
                    };
                    ops.push(BlitOp {
                        view: cached.slot.view.clone(),
                        dest,
                        src: None,
                        alpha: image.opacity,
                        capture: false,
                    });
                }
                ValidatedLayer::Text(text) => {
                    let Some(cached) = self.statics.iter().find(|item| item.id == text.id) else {
                        continue;
                    };
                    ops.push(BlitOp {
                        view: cached.slot.view.clone(),
                        dest: dest_rect(text.transform, self.out_w, self.out_h),
                        src: None,
                        alpha: text.opacity,
                        capture: false,
                    });
                }
                ValidatedLayer::OverlayChrome { .. } => {}
            }
        }
        // Match Live Output Preview: filter chrome sits above scene sources, HUD last.
        for cached in &self.overlays {
            ops.push(BlitOp {
                view: cached.slot.view.clone(),
                dest: PixelRect {
                    x: 0,
                    y: 0,
                    w: self.out_w,
                    h: self.out_h,
                },
                src: None,
                alpha: 1.0,
                capture: false,
            });
        }
        for cached in &self.hud {
            ops.push(BlitOp {
                view: cached.slot.view.clone(),
                dest: hud_rect(&cached.id, cached.src_w, cached.src_h, self.out_w, self.out_h, spec.hud.as_ref()),
                src: None,
                alpha: 1.0,
                capture: false,
            });
        }
        Ok(ops)
    }

    fn blt(&self, spec: &ValidatedComposition, ops: &[BlitOp]) -> Result<(), String> {
        if ops.is_empty() {
            return Err("Composed recording had no visible layers.".into());
        }
        unsafe {
            let mut streams = vec![D3D11_VIDEO_PROCESSOR_STREAM::default(); ops.len()];
            for (index, op) in ops.iter().enumerate() {
                if op.dest.is_empty() {
                    continue;
                }
                let src_rect = op.src.map(to_rect);
                let dest_rect_px = to_rect(op.dest);
                self.gpu.video_ctx.VideoProcessorSetStreamSourceRect(
                    &self.processor,
                    index as u32,
                    src_rect.is_some(),
                    src_rect.as_ref().map(|rect| rect as *const RECT),
                );
                self.gpu.video_ctx.VideoProcessorSetStreamDestRect(
                    &self.processor,
                    index as u32,
                    true,
                    Some(&dest_rect_px as *const RECT),
                );
                self.gpu.video_ctx.VideoProcessorSetStreamAlpha(
                    &self.processor,
                    index as u32,
                    op.alpha < 0.999,
                    op.alpha,
                );
                if op.capture {
                    filters::apply_stream_filters(
                        &self.enumerator,
                        &self.gpu.video_ctx,
                        &self.processor,
                        index as u32,
                        spec.filter,
                    );
                }
                streams[index] = D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: BOOL(1),
                    pInputSurface: ManuallyDrop::new(Some(op.view.clone())),
                    ..Default::default()
                };
            }
            let blt = self.gpu.video_ctx.VideoProcessorBlt(
                &self.processor,
                &self.output_view,
                0,
                &streams,
            );
            for stream in &streams {
                drop(ManuallyDrop::into_inner(std::ptr::read(&stream.pInputSurface)));
            }
            if let Err(err) = blt {
                if let Err(lost) = self.gpu.check_device() {
                    return Err(lost);
                }
                return Err(format!("VideoProcessorBlt failed: {err}"));
            }
            let src: ID3D11Resource = self
                .output
                .cast()
                .map_err(|err| format!("compose output cast: {err}"))?;
            let dst: ID3D11Resource = self
                .sync
                .cast()
                .map_err(|err| format!("compose sync cast: {err}"))?;
            self.gpu
                .context
                .CopySubresourceRegion(&dst, 0, 0, 0, 0, &src, 0, None);
        }
        let done = GpuEvent::create(&self.gpu.device)?;
        done.end(&self.gpu.context);
        unsafe { self.gpu.context.Flush() };
        done.wait(&self.gpu)?;
        Ok(())
    }

    fn cache_decoded(&mut self, id: &str, decoded: &DecodedImage) -> Result<(), String> {
        self.cache_pixels(id, &decoded.bgra, decoded.width, decoded.height)
    }

    fn cache_pixels(&mut self, id: &str, bgra: &[u8], width: u32, height: u32) -> Result<(), String> {
        let slot = self.create_slot(width, height)?;
        upload_bgra(&self.gpu, &slot.texture, bgra, width, height, width * 4)?;
        self.statics.push(CachedStill {
            id: id.to_string(),
            src_w: width,
            src_h: height,
            slot,
        });
        Ok(())
    }

    fn cache_hud(&mut self, id: String, bgra: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
        let slot = self.create_slot(width, height)?;
        upload_bgra(&self.gpu, &slot.texture, &bgra, width, height, width * 4)?;
        self.hud.push(CachedStill {
            id,
            src_w: width,
            src_h: height,
            slot,
        });
        Ok(())
    }

    fn ensure_live_slot(&mut self, webcam: bool, frame: &StillFrame) -> Result<(), String> {
        let needs = match if webcam { self.webcam.as_ref() } else { self.capture.as_ref() } {
            Some(slot) if slot.width == frame.width && slot.height == frame.height => false,
            _ => true,
        };
        if needs {
            let slot = self.create_slot(frame.width, frame.height)?;
            if webcam {
                self.webcam = Some(slot);
            } else {
                self.capture = Some(slot);
            }
        }
        Ok(())
    }

    fn create_slot(&self, width: u32, height: u32) -> Result<LayerSlot, String> {
        let width = even_dim(width, 2);
        let height = even_dim(height, 2);
        let texture = create_bgra_input(&self.gpu.device, width, height)?;
        let view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
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
            self.gpu
                .video
                .CreateVideoProcessorInputView(&texture, &self.enumerator, &view_desc, Some(&mut view))
                .map_err(|err| format!("Could not create a compose input view: {err}"))?;
        }
        Ok(LayerSlot {
            texture,
            view: view.ok_or_else(|| "Compose input view was empty.".to_string())?,
            width,
            height,
        })
    }
}

fn hud_rect(
    id: &str,
    w: u32,
    h: u32,
    canvas_w: u32,
    canvas_h: u32,
    hud: Option<&ValidatedHud>,
) -> PixelRect {
    let pad = 12i32;
    if id == "hud-rec" {
        return PixelRect {
            x: canvas_w as i32 - w as i32 - pad,
            y: pad,
            w,
            h,
        };
    }
    if id == "hud-clock" {
        let right = hud
            .map(|item| item.filter == ComposedFilterId::Dashcam)
            .unwrap_or(false);
        return PixelRect {
            x: if right {
                canvas_w as i32 - w as i32 - pad
            } else {
                pad
            },
            y: canvas_h as i32 - h as i32 - pad,
            w,
            h,
        };
    }
    PixelRect {
        x: pad,
        y: pad,
        w,
        h,
    }
}

fn wall_clock_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    // Civil date from Unix days (Howard Hinnant). Display only; not a media timestamp.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp as i64 + if mp < 10 { 3 } else { -9 };
    let y = y + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {hour:02}:{min:02}:{sec:02}")
}

fn to_rect(rect: PixelRect) -> RECT {
    RECT {
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.w as i32,
        bottom: rect.y + rect.h as i32,
    }
}
