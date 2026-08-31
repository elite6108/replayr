use std::collections::VecDeque;
use std::mem::ManuallyDrop;

use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Resource, ID3D11Texture2D, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CAPS, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};

use crate::overlay::{overlay_box, overlay_cover_source, OverlayLayout};
use crate::export::compose::sizing::fit_compose_size;

use super::BOUNDARY_LOG_FROM;
use super::decode::DxgiFrame;
use super::device::{
    device_removed_reason, format_name, gpu_fail, raw_ptr, GpuEvent, GpuFailDiag, SharedGpu,
};
use super::diagnostics::{log_surface_transition, SurfaceHop};

#[allow(dead_code)]
const BOUNDARY_VP: &str = "video_processor_output";
#[allow(dead_code)]
const BOUNDARY_BLT: &str = "video_processor_blt";

const VP_OUTPUT_RING: usize = 16;
const VP_INPUT_RING: usize = 4;

pub(super) struct BlitResult {
    pub(super) texture: ID3D11Texture2D,
    pub(super) owned_gameplay: ID3D11Texture2D,
    pub(super) blt_hr: i32,
    pub(super) input_slot: usize,
    pub(super) output_slot: usize,
    pub(super) decoder_slice: u32,
    pub(super) hops: Vec<SurfaceHop>,
}

struct VpOutput {
    pub(super) texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorOutputView,
    gpu_done: GpuEvent,
    encoder_busy: bool,
}

struct VpInputSlot {
    pub(super) texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorInputView,
    copy_done: GpuEvent,
    width: u32,
    height: u32,
}

pub(super) struct VideoCompositor {
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    outputs: Vec<VpOutput>,
    gameplay_inputs: Vec<VpInputSlot>,
    webcam_inputs: Vec<VpInputSlot>,
    next_output: usize,
    next_gameplay: usize,
    next_webcam: usize,
    pub(super) encoder_q: VecDeque<usize>,
    last_input_slot: usize,
    last_output_slot: usize,
    last_decoder_slice: u32,
    sync_tex: ID3D11Texture2D,
    out_w: u32,
    out_h: u32,
}

impl VideoCompositor {
    pub(super) fn open(
        gpu: &SharedGpu,
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        fps: u32,
    ) -> Result<Self, String> {
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            },
            InputWidth: in_w.max(2),
            InputHeight: in_h.max(2),
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
            let input_ok = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32
                != 0;
            let output_ok = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32
                != 0;
            if !input_ok || !output_ok {
                return Err("D3D11 video processor cannot take NV12 in and out.".into());
            }
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            enumerator
                .GetVideoProcessorCaps(&mut caps)
                .map_err(|err| format!("Could not query video processor caps: {err}"))?;
            if caps.MaxInputStreams < 2 {
                return Err("D3D11 video processor cannot composite two streams.".into());
            }
            let processor = gpu
                .video
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|err| format!("Could not create the video processor: {err}"))?;
            let bind_flags = (D3D11_BIND_RENDER_TARGET.0
                | D3D11_BIND_SHADER_RESOURCE.0
                | D3D11_BIND_VIDEO_ENCODER.0) as u32;
            let tex_desc = D3D11_TEXTURE2D_DESC {
                Width: out_w,
                Height: out_h,
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
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut outputs = Vec::with_capacity(VP_OUTPUT_RING);
            for _ in 0..VP_OUTPUT_RING {
                let mut output = None;
                gpu.device
                    .CreateTexture2D(&tex_desc, None, Some(&mut output))
                    .map_err(|err| format!("Could not create the NV12 compose target: {err}"))?;
                let output = output.ok_or_else(|| "NV12 compose target was empty.".to_string())?;
                let mut output_view = None;
                gpu.video
                    .CreateVideoProcessorOutputView(
                        &output,
                        &enumerator,
                        &view_desc,
                        Some(&mut output_view),
                    )
                    .map_err(|err| {
                        format!("Could not create the video processor output view: {err}")
                    })?;
                let view = output_view
                    .ok_or_else(|| "Video processor output view was empty.".to_string())?;
                outputs.push(VpOutput {
                    texture: output,
                    view,
                    gpu_done: GpuEvent::create(&gpu.device)?,
                    encoder_busy: false,
                });
            }
            gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                &processor,
                1,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            gpu.video_ctx
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            gpu.video_ctx
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 1, false);
            tracing::info!(
                vp_input = "NV12",
                vp_output = "NV12",
                output = format!("{out_w}x{out_h}"),
                gameplay_input = format!("{in_w}x{in_h}"),
                ring = VP_OUTPUT_RING,
                bind_flags = format!("{bind_flags:#x}"),
                "D3D11 VideoProcessor formats"
            );
            Ok(Self {
                enumerator,
                processor,
                outputs,
                gameplay_inputs: Vec::new(),
                webcam_inputs: Vec::new(),
                next_output: 0,
                next_gameplay: 0,
                next_webcam: 0,
                encoder_q: VecDeque::new(),
                last_input_slot: 0,
                last_output_slot: 0,
                last_decoder_slice: 0,
                sync_tex: {
                    let mut sync = None;
                    gpu.device
                        .CreateTexture2D(&tex_desc, None, Some(&mut sync))
                        .map_err(|err| format!("Could not create the VP/encode sync surface: {err}"))?;
                    sync.ok_or_else(|| "VP/encode sync surface was empty.".to_string())?
                },
                out_w,
                out_h,
            })
        }
    }

    pub(super) fn blit(
        &mut self,
        gpu: &SharedGpu,
        gameplay: &DxgiFrame,
        webcam: Option<&DxgiFrame>,
        layout: &OverlayLayout,
        diag: &GpuFailDiag,
        frame_index: u64,
    ) -> Result<BlitResult, String> {
        self.ensure_input_ring(gpu, gameplay, false, diag)?;
        if let Some(cam) = webcam {
            self.ensure_input_ring(gpu, cam, true, diag)?;
        }

        let mut hops = Vec::new();
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "decoder_dxgi_slice",
                Some(&gameplay.texture),
                gameplay.subresource,
                -1,
                gameplay.subresource,
                "0x0",
            ));
        }

        let gp_slot = self.next_gameplay;
        self.next_gameplay = (self.next_gameplay + 1) % self.gameplay_inputs.len();
        copy_decoder_to_owned(gpu, &self.gameplay_inputs[gp_slot], gameplay, diag)?;
        self.gameplay_inputs[gp_slot].copy_done.end(&gpu.context)?;
        unsafe { gpu.context.Flush() };
        self.gameplay_inputs[gp_slot]
            .copy_done
            .wait(gpu, diag)?;
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "owned_gameplay_ring",
                Some(&self.gameplay_inputs[gp_slot].texture),
                0,
                gp_slot as i64,
                gameplay.subresource,
                "0x0",
            ));
        }

        let cam_slot = if let Some(cam) = webcam {
            let slot = self.next_webcam;
            self.next_webcam = (self.next_webcam + 1) % self.webcam_inputs.len();
            copy_decoder_to_owned(gpu, &self.webcam_inputs[slot], cam, diag)?;
            self.webcam_inputs[slot].copy_done.end(&gpu.context)?;
            unsafe { gpu.context.Flush() };
            self.webcam_inputs[slot].copy_done.wait(gpu, diag)?;
            Some(slot)
        } else {
            None
        };

        let out_slot = self
            .outputs
            .iter()
            .enumerate()
            .cycle()
            .skip(self.next_output)
            .take(self.outputs.len())
            .find(|(_, slot)| !slot.encoder_busy)
            .map(|(idx, _)| idx)
            .ok_or_else(|| "output_ring_full".to_string())?;
        self.next_output = (out_slot + 1) % self.outputs.len();
        self.last_input_slot = gp_slot;
        self.last_output_slot = out_slot;
        self.last_decoder_slice = gameplay.subresource;

        let gameplay_view = self.gameplay_inputs[gp_slot].view.clone();
        let cam_view = cam_slot.map(|slot| self.webcam_inputs[slot].view.clone());
        let output_view = self.outputs[out_slot].view.clone();
        let output_tex = self.outputs[out_slot].texture.clone();
        let owned_gameplay = self.gameplay_inputs[gp_slot].texture.clone();
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "vp_input_view",
                Some(&owned_gameplay),
                0,
                gp_slot as i64,
                gameplay.subresource,
                "0x0",
            ));
            tracing::info!(
                frame_index,
                hop = "vp_input_view",
                view_ptr = format!("{:#x}", raw_ptr(&gameplay_view)),
                texture_ptr = format!("{:#x}", raw_ptr(&owned_gameplay)),
                subresource = 0,
                ring_slot = gp_slot,
                decoder_slice = gameplay.subresource,
                "surface transition view"
            );
        }

        unsafe {
            let gameplay_dest = gameplay_dest_rect(
                gameplay.width,
                gameplay.height,
                self.out_w,
                self.out_h,
            );
            gpu.video_ctx
                .VideoProcessorSetStreamSourceRect(&self.processor, 0, false, None);
            gpu.video_ctx.VideoProcessorSetStreamDestRect(
                &self.processor,
                0,
                true,
                Some(&gameplay_dest),
            );

            let mut streams = [
                D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: BOOL(1),
                    pInputSurface: ManuallyDrop::new(Some(gameplay_view)),
                    ..Default::default()
                },
                D3D11_VIDEO_PROCESSOR_STREAM::default(),
            ];
            if let (Some(cam), Some(view)) = (webcam, cam_view.as_ref()) {
                let aspect = cam.width as f32 / cam.height.max(1) as f32;
                let (ox, oy, box_w, box_h) = overlay_box(self.out_w, self.out_h, aspect, layout);
                if box_w > 0 && box_h > 0 {
                    let dest = even_rect(ox, oy, box_w, box_h, self.out_w, self.out_h);
                    let (sx, sy, sw, sh) =
                        overlay_cover_source(cam.width, cam.height, box_w, box_h);
                    let src = even_rect(sx, sy, sw, sh, cam.width, cam.height);
                    gpu.video_ctx.VideoProcessorSetStreamSourceRect(
                        &self.processor,
                        1,
                        true,
                        Some(&src),
                    );
                    gpu.video_ctx.VideoProcessorSetStreamDestRect(
                        &self.processor,
                        1,
                        true,
                        Some(&dest),
                    );
                    streams[1] = D3D11_VIDEO_PROCESSOR_STREAM {
                        Enable: BOOL(1),
                        pInputSurface: ManuallyDrop::new(Some(view.clone())),
                        ..Default::default()
                    };
                }
            }
            let stream_count = if streams[1].Enable.0 != 0 { 2 } else { 1 };
            let blt = gpu
                .video_ctx
                .VideoProcessorBlt(&self.processor, &output_view, 0, &streams[..stream_count]);
            drop(ManuallyDrop::into_inner(std::ptr::read(
                &streams[0].pInputSurface,
            )));
            drop(ManuallyDrop::into_inner(std::ptr::read(
                &streams[1].pInputSurface,
            )));
            match blt {
                Ok(()) => {
                    // VideoProcessor writes on the video engine. An immediate-context
                    // EVENT query does not wait for that engine. A 3D copy after Blt
                    // creates a dependency the query can actually wait on.
                    let src: ID3D11Resource = output_tex.cast().map_err(|err| {
                        format!("VP output cast hr={:#x}", err.code().0 as u32)
                    })?;
                    let dst: ID3D11Resource = self.sync_tex.cast().map_err(|err| {
                        format!("sync surface cast hr={:#x}", err.code().0 as u32)
                    })?;
                    gpu.context.CopySubresourceRegion(&dst, 0, 0, 0, 0, &src, 0, None);
                    self.outputs[out_slot].gpu_done.end(&gpu.context)?;
                    gpu.context.Flush();
                    self.outputs[out_slot].gpu_done.wait(gpu, diag)?;
                    if frame_index >= BOUNDARY_LOG_FROM {
                        hops.push(log_surface_transition(
                            frame_index,
                            "videoprocessor_blt",
                            Some(&output_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                        hops.push(log_surface_transition(
                            frame_index,
                            "vp_output",
                            Some(&output_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                        hops.push(log_surface_transition(
                            frame_index,
                            "sync_output_ring",
                            Some(&self.sync_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                    }
                    Ok(BlitResult {
                        texture: output_tex,
                        owned_gameplay,
                        blt_hr: 0,
                        input_slot: gp_slot,
                        output_slot: out_slot,
                        decoder_slice: gameplay.subresource,
                        hops,
                    })
                }
                Err(err) => Err(format!(
                    "VideoProcessorBlt hr={:#x} {err}",
                    err.code().0 as u32
                )),
            }
        }
    }

    pub(super) fn copy_gameplay_owned(
        &mut self,
        gpu: &SharedGpu,
        gameplay: &DxgiFrame,
        diag: &GpuFailDiag,
        frame_index: u64,
    ) -> Result<BlitResult, String> {
        self.ensure_input_ring(gpu, gameplay, false, diag)?;
        let mut hops = Vec::new();
        hops.push(log_surface_transition(
            frame_index,
            "decoder_dxgi_slice",
            Some(&gameplay.texture),
            gameplay.subresource,
            -1,
            gameplay.subresource,
            "0x0",
        ));
        let gp_slot = self.next_gameplay;
        self.next_gameplay = (self.next_gameplay + 1) % self.gameplay_inputs.len();
        copy_decoder_to_owned(gpu, &self.gameplay_inputs[gp_slot], gameplay, diag)?;
        self.gameplay_inputs[gp_slot].copy_done.end(&gpu.context)?;
        unsafe { gpu.context.Flush() };
        self.gameplay_inputs[gp_slot].copy_done.wait(gpu, diag)?;
        self.last_input_slot = gp_slot;
        self.last_decoder_slice = gameplay.subresource;
        let owned_gameplay = self.gameplay_inputs[gp_slot].texture.clone();
        hops.push(log_surface_transition(
            frame_index,
            "owned_gameplay_ring",
            Some(&owned_gameplay),
            0,
            gp_slot as i64,
            gameplay.subresource,
            "0x0",
        ));
        Ok(BlitResult {
            texture: owned_gameplay.clone(),
            owned_gameplay,
            blt_hr: 0,
            input_slot: gp_slot,
            output_slot: usize::MAX,
            decoder_slice: gameplay.subresource,
            hops,
        })
    }

    fn ensure_input_ring(
        &mut self,
        gpu: &SharedGpu,
        template: &DxgiFrame,
        webcam: bool,
        _diag: &GpuFailDiag,
    ) -> Result<(), String> {
        let ready = if webcam {
            !self.webcam_inputs.is_empty()
                && self.webcam_inputs[0].width == template.width
                && self.webcam_inputs[0].height == template.height
        } else {
            !self.gameplay_inputs.is_empty()
                && self.gameplay_inputs[0].width == template.width
                && self.gameplay_inputs[0].height == template.height
        };
        if ready {
            return Ok(());
        }
        let created = create_owned_input_ring(gpu, &self.enumerator, template, webcam)?;
        if webcam {
            self.webcam_inputs = created;
            self.next_webcam = 0;
        } else {
            self.gameplay_inputs = created;
            self.next_gameplay = 0;
        }
        Ok(())
    }

    pub(super) fn has_free_output(&self) -> bool {
        self.outputs.iter().any(|slot| !slot.encoder_busy)
    }

    pub(super) fn submit_output(&mut self, slot: usize) {
        self.outputs[slot].encoder_busy = true;
        self.encoder_q.push_back(slot);
    }

    pub(super) fn release_encoder(&mut self) {
        if let Some(slot) = self.encoder_q.pop_front() {
            self.outputs[slot].encoder_busy = false;
        }
    }

    fn input_ring_busy(&self) -> u32 {
        0
    }

    fn output_ring_busy(&self) -> u32 {
        self.outputs.iter().filter(|slot| slot.encoder_busy).count() as u32
    }

    pub(super) fn diag(
        &self,
        frame: u64,
        encoded: u64,
        gameplay_held: bool,
        webcam_held: bool,
    ) -> GpuFailDiag {
        let decoder_slices = u32::from(gameplay_held) + u32::from(webcam_held);
        GpuFailDiag {
            frame,
            encoded,
            in_flight: frame.saturating_sub(encoded),
            input_slot: self.last_input_slot,
            output_slot: self.last_output_slot,
            decoder_slice: self.last_decoder_slice,
            input_ring_busy: self.input_ring_busy(),
            output_ring_busy: self.output_ring_busy(),
            decoder_slices_referenced: decoder_slices,
            encoder_in_flight: self.encoder_q.len() as u32,
            vp_input_views: (self.gameplay_inputs.len() + self.webcam_inputs.len()) as u32,
            vp_output_views: self.outputs.len() as u32,
            outstanding_input_samples: decoder_slices,
            outstanding_output_samples: self.encoder_q.len() as u32,
        }
    }

    pub(super) fn log_long_run(&self, gpu: &SharedGpu, frame: u64, encoded: u64, webcam_held: bool) {
        let (removed_hr, removed_name) = device_removed_reason(gpu);
        let diag = self.diag(frame, encoded, true, webcam_held);
        tracing::info!(
            frame_index = frame,
            encoded,
            in_flight = diag.in_flight,
            input_ring_busy = diag.input_ring_busy,
            output_ring_busy = diag.output_ring_busy,
            decoder_slices_referenced = diag.decoder_slices_referenced,
            encoder_in_flight = diag.encoder_in_flight,
            vp_input_views_alive = diag.vp_input_views,
            vp_output_views_alive = diag.vp_output_views,
            cpu_map_count = 0,
            device_removed_hr = format!("{removed_hr:#x}"),
            device_removed_name = removed_name,
            "gpu_dxgi long-run resource diagnostics"
        );
    }
}

fn gameplay_dest_rect(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> RECT {
    let (fit_w, fit_h) = fit_compose_size(src_w, src_h, dst_w, dst_h);
    let x = dst_w.saturating_sub(fit_w) / 2;
    let y = dst_h.saturating_sub(fit_h) / 2;
    even_rect(x, y, fit_w, fit_h, dst_w, dst_h)
}

fn create_owned_input_ring(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    template: &DxgiFrame,
    webcam: bool,
) -> Result<Vec<VpInputSlot>, String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { template.texture.GetDesc(&mut desc) };
    tracing::info!(
        stream = if webcam { "webcam" } else { "gameplay" },
        format = format_name(desc.Format),
        width = template.width,
        height = template.height,
        decoder_bind = format!("{:#x}", desc.BindFlags),
        decoder_array = desc.ArraySize,
        "owned VideoProcessor input ring template"
    );
    desc.Width = template.width.max(2);
    desc.Height = template.height.max(2);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = 0;
    desc.SampleDesc = DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
    };
    let bind_attempts = [
        (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_VIDEO_ENCODER.0)
            as u32,
        (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        D3D11_BIND_SHADER_RESOURCE.0 as u32,
        D3D11_BIND_VIDEO_ENCODER.0 as u32,
        0,
    ];
    let mut last_err = "no bind-flag attempt ran".to_string();
    for bind in bind_attempts {
        desc.BindFlags = bind;
        match create_owned_input_slot(gpu, enumerator, &desc, template.width, template.height) {
            Ok(first) => {
                let mut ring = Vec::with_capacity(VP_INPUT_RING);
                ring.push(first);
                for _ in 1..VP_INPUT_RING {
                    ring.push(create_owned_input_slot(
                        gpu,
                        enumerator,
                        &desc,
                        template.width,
                        template.height,
                    )?);
                }
                tracing::info!(
                    stream = if webcam { "webcam" } else { "gameplay" },
                    bind_flags = format!("{bind:#x}"),
                    slots = ring.len(),
                    "owned VideoProcessor input ring created"
                );
                return Ok(ring);
            }
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

fn create_owned_input_slot(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    desc: &D3D11_TEXTURE2D_DESC,
    width: u32,
    height: u32,
) -> Result<VpInputSlot, String> {
    let mut texture = None;
    unsafe {
        gpu.device
            .CreateTexture2D(desc, None, Some(&mut texture))
            .map_err(|err| format!("Could not create owned VP input hr={:#x} {err}", err.code().0 as u32))?;
    }
    let texture = texture.ok_or_else(|| "owned VP input surface was empty.".to_string())?;
    let view = input_view(gpu, enumerator, &texture, 0)?;
    Ok(VpInputSlot {
        texture,
        view,
        copy_done: GpuEvent::create(&gpu.device)?,
        width,
        height,
    })
}

fn copy_decoder_to_owned(
    gpu: &SharedGpu,
    dest: &VpInputSlot,
    src: &DxgiFrame,
    diag: &GpuFailDiag,
) -> Result<(), String> {
    let dst: ID3D11Resource = dest.texture.cast().map_err(|err| {
        gpu_fail(gpu, "owned_input_cast", err.code().0 as u32, diag)
    })?;
    let source: ID3D11Resource = src.texture.cast().map_err(|err| {
        gpu_fail(gpu, "decoder_surface_cast", err.code().0 as u32, diag)
    })?;
    unsafe {
        gpu.context
            .CopySubresourceRegion(&dst, 0, 0, 0, 0, &source, src.subresource, None);
    }
    Ok(())
}

fn input_view(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    texture: &ID3D11Texture2D,
    subresource: u32,
) -> Result<ID3D11VideoProcessorInputView, String> {
    let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: subresource,
            },
        },
    };
    let mut view = None;
    unsafe {
        gpu.video
            .CreateVideoProcessorInputView(texture, enumerator, &desc, Some(&mut view))
            .map_err(|err| format!("Could not create a video processor input view: {err}"))?;
    }
    view.ok_or_else(|| "Video processor input view was empty.".into())
}

fn even_rect(x: u32, y: u32, w: u32, h: u32, max_w: u32, max_h: u32) -> RECT {
    let x = x & !1;
    let y = y & !1;
    let w = w.max(2) & !1;
    let h = h.max(2) & !1;
    let right = (x + w).min(max_w) as i32;
    let bottom = (y + h).min(max_h) as i32;
    RECT {
        left: x.min(max_w.saturating_sub(2)) as i32,
        top: y.min(max_h.saturating_sub(2)) as i32,
        right: right.max(2),
        bottom: bottom.max(2),
    }
}