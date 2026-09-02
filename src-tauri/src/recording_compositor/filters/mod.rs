//! Recording-only visual filters. Instant Replay / clip filters are untouched.

#![cfg(windows)]

use windows::Win32::Graphics::Direct3D11::{
    ID3D11VideoContext, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    D3D11_VIDEO_PROCESSOR_FILTER, D3D11_VIDEO_PROCESSOR_FILTER_BRIGHTNESS,
    D3D11_VIDEO_PROCESSOR_FILTER_CONTRAST, D3D11_VIDEO_PROCESSOR_FILTER_HUE,
    D3D11_VIDEO_PROCESSOR_FILTER_NOISE_REDUCTION, D3D11_VIDEO_PROCESSOR_FILTER_SATURATION,
};

use super::scene::ComposedFilterId;

#[derive(Debug, Clone, Copy)]
pub struct FilterTune {
    pub brightness: Option<f32>,
    pub contrast: Option<f32>,
    pub saturation: Option<f32>,
    pub hue: Option<f32>,
    pub noise: Option<f32>,
}

pub fn tune_for(filter: ComposedFilterId) -> FilterTune {
    match filter {
        ComposedFilterId::None => FilterTune {
            brightness: None,
            contrast: None,
            saturation: None,
            hue: None,
            noise: None,
        },
        ComposedFilterId::Bodycam => FilterTune {
            brightness: Some(-0.04),
            contrast: Some(0.12),
            saturation: Some(-0.18),
            hue: None,
            noise: Some(0.08),
        },
        ComposedFilterId::Dashcam => FilterTune {
            brightness: Some(0.04),
            contrast: Some(0.08),
            saturation: Some(-0.06),
            hue: Some(-0.04),
            noise: None,
        },
        ComposedFilterId::Vhs => FilterTune {
            brightness: Some(0.02),
            contrast: Some(0.16),
            saturation: Some(-0.22),
            hue: Some(0.03),
            noise: Some(0.35),
        },
        ComposedFilterId::Cinematic => FilterTune {
            brightness: Some(-0.06),
            contrast: Some(0.22),
            saturation: Some(-0.12),
            hue: None,
            noise: None,
        },
    }
}

/// Apply GPU VideoProcessor color filters to one stream. No CPU frame maps.
pub fn apply_stream_filters(
    enumerator: &ID3D11VideoProcessorEnumerator,
    ctx: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    stream: u32,
    filter: ComposedFilterId,
) {
    let tune = tune_for(filter);
    set_filter(enumerator, ctx, processor, stream, D3D11_VIDEO_PROCESSOR_FILTER_BRIGHTNESS, tune.brightness);
    set_filter(enumerator, ctx, processor, stream, D3D11_VIDEO_PROCESSOR_FILTER_CONTRAST, tune.contrast);
    set_filter(enumerator, ctx, processor, stream, D3D11_VIDEO_PROCESSOR_FILTER_SATURATION, tune.saturation);
    set_filter(enumerator, ctx, processor, stream, D3D11_VIDEO_PROCESSOR_FILTER_HUE, tune.hue);
    set_filter(
        enumerator,
        ctx,
        processor,
        stream,
        D3D11_VIDEO_PROCESSOR_FILTER_NOISE_REDUCTION,
        tune.noise,
    );
}

fn set_filter(
    enumerator: &ID3D11VideoProcessorEnumerator,
    ctx: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    stream: u32,
    kind: D3D11_VIDEO_PROCESSOR_FILTER,
    amount: Option<f32>,
) {
    let Some(amount) = amount else {
        return;
    };
    let range = unsafe { enumerator.GetVideoProcessorFilterRange(kind) };
    let Ok(range) = range else {
        return;
    };
    let min = range.Minimum as f32;
    let max = range.Maximum as f32;
    let default = range.Default as f32;
    let span = (max - min).abs().max(1.0);
    let value = (default + amount * span * 0.5).clamp(min, max).round() as i32;
    unsafe {
        ctx.VideoProcessorSetStreamFilter(processor, stream, kind, true, value);
    }
}
