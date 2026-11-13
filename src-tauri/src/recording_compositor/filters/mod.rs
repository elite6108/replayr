//! Recording-only visual filters. Instant Replay / clip filters are untouched.

#![cfg(windows)]

use windows::Win32::Graphics::Direct3D11::{
    ID3D11VideoContext, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    D3D11_VIDEO_PROCESSOR_FILTER, D3D11_VIDEO_PROCESSOR_FILTER_BRIGHTNESS,
    D3D11_VIDEO_PROCESSOR_FILTER_CONTRAST, D3D11_VIDEO_PROCESSOR_FILTER_EDGE_ENHANCEMENT,
    D3D11_VIDEO_PROCESSOR_FILTER_HUE, D3D11_VIDEO_PROCESSOR_FILTER_NOISE_REDUCTION,
    D3D11_VIDEO_PROCESSOR_FILTER_SATURATION,
};

use super::scene::{ComposedFilterId, CompositionPicture};

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

/// How a picture adjustment changes a filter, in the filter's real units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PictureOp {
    None,
    /// Added to the value (brightness in luma steps, hue in degrees).
    Offset(f32),
    /// Multiplies the value (contrast, saturation).
    Scale(f32),
    /// Fraction of the way from the minimum to the maximum (edge enhancement).
    Fraction(f32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterRange {
    pub min: i32,
    pub max: i32,
    pub default: i32,
    pub multiplier: f32,
}

/// Picture slider values mapped onto the VideoProcessor filters. Brightness
/// +100 lifts luma by 50 steps, contrast and saturation scale by 0..2, and
/// hue rotates in degrees, matching the preview's CSS filter closely.
pub fn picture_ops(picture: &CompositionPicture) -> [(D3D11_VIDEO_PROCESSOR_FILTER, PictureOp); 5] {
    let offset = |value: f32, per_unit: f32| {
        if value == 0.0 {
            PictureOp::None
        } else {
            PictureOp::Offset(value * per_unit)
        }
    };
    let scale = |value: f32| {
        if value == 0.0 {
            PictureOp::None
        } else {
            PictureOp::Scale(1.0 + value / 100.0)
        }
    };
    [
        (D3D11_VIDEO_PROCESSOR_FILTER_BRIGHTNESS, offset(picture.brightness, 0.5)),
        (D3D11_VIDEO_PROCESSOR_FILTER_CONTRAST, scale(picture.contrast)),
        (D3D11_VIDEO_PROCESSOR_FILTER_SATURATION, scale(picture.saturation)),
        (D3D11_VIDEO_PROCESSOR_FILTER_HUE, offset(picture.hue, 1.0)),
        (
            D3D11_VIDEO_PROCESSOR_FILTER_EDGE_ENHANCEMENT,
            if picture.sharpness > 0.0 {
                PictureOp::Fraction(picture.sharpness / 100.0)
            } else {
                PictureOp::None
            },
        ),
    ]
}

/// Final filter level, or `None` to turn the filter off. `scene` is the
/// overlay filter's amount (a fraction of half the range around the default).
pub fn filter_level(range: FilterRange, scene: Option<f32>, picture: PictureOp) -> Option<i32> {
    if scene.is_none() && picture == PictureOp::None {
        return None;
    }
    let min = range.min.min(range.max) as f32;
    let max = range.min.max(range.max) as f32;
    let default = range.default as f32;
    let span = (max - min).max(1.0);
    let mut level = scene.map_or(default, |amount| default + amount * span * 0.5);
    let multiplier = if range.multiplier.is_finite() && range.multiplier > 0.0 {
        range.multiplier
    } else {
        1.0
    };
    match picture {
        PictureOp::None => {}
        PictureOp::Offset(units) => level += units / multiplier,
        PictureOp::Scale(factor) => level *= factor.max(0.0),
        PictureOp::Fraction(fraction) => level = min + span * fraction.clamp(0.0, 1.0),
    }
    if !level.is_finite() {
        return None;
    }
    Some(level.clamp(min, max).round() as i32)
}

/// Set or clear every GPU VideoProcessor filter on one stream. Filters stick
/// to the stream index between Blt calls, so each call must cover all of them.
pub fn apply_stream_filters(
    enumerator: &ID3D11VideoProcessorEnumerator,
    ctx: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    stream: u32,
    filter: Option<ComposedFilterId>,
    picture: &CompositionPicture,
) {
    let tune = tune_for(filter.unwrap_or(ComposedFilterId::None));
    let scene_amount = |kind: D3D11_VIDEO_PROCESSOR_FILTER| match kind {
        D3D11_VIDEO_PROCESSOR_FILTER_BRIGHTNESS => tune.brightness,
        D3D11_VIDEO_PROCESSOR_FILTER_CONTRAST => tune.contrast,
        D3D11_VIDEO_PROCESSOR_FILTER_SATURATION => tune.saturation,
        D3D11_VIDEO_PROCESSOR_FILTER_HUE => tune.hue,
        _ => None,
    };
    for (kind, op) in picture_ops(picture) {
        set_filter(enumerator, ctx, processor, stream, kind, scene_amount(kind), op);
    }
    set_filter(
        enumerator,
        ctx,
        processor,
        stream,
        D3D11_VIDEO_PROCESSOR_FILTER_NOISE_REDUCTION,
        tune.noise,
        PictureOp::None,
    );
}

/// Turn every filter off on one stream (BGRA to NV12 conversion reuses stream 0).
pub fn clear_stream_filters(
    enumerator: &ID3D11VideoProcessorEnumerator,
    ctx: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    stream: u32,
) {
    apply_stream_filters(enumerator, ctx, processor, stream, None, &CompositionPicture::default());
}

fn set_filter(
    enumerator: &ID3D11VideoProcessorEnumerator,
    ctx: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    stream: u32,
    kind: D3D11_VIDEO_PROCESSOR_FILTER,
    scene: Option<f32>,
    picture: PictureOp,
) {
    let Ok(range) = (unsafe { enumerator.GetVideoProcessorFilterRange(kind) }) else {
        return;
    };
    let range = FilterRange {
        min: range.Minimum,
        max: range.Maximum,
        default: range.Default,
        multiplier: range.Multiplier,
    };
    unsafe {
        match filter_level(range, scene, picture) {
            Some(value) => ctx.VideoProcessorSetStreamFilter(processor, stream, kind, true, value),
            None => ctx.VideoProcessorSetStreamFilter(processor, stream, kind, false, range.default),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRIGHTNESS: FilterRange = FilterRange { min: -100, max: 100, default: 0, multiplier: 1.0 };
    const CONTRAST: FilterRange = FilterRange { min: 0, max: 1000, default: 100, multiplier: 0.01 };
    const EDGE: FilterRange = FilterRange { min: 0, max: 64, default: 0, multiplier: 1.0 };

    #[test]
    fn untouched_filters_are_turned_off() {
        assert_eq!(filter_level(BRIGHTNESS, None, PictureOp::None), None);
    }

    #[test]
    fn picture_combines_with_scene_and_clamps() {
        assert_eq!(filter_level(BRIGHTNESS, None, PictureOp::Offset(50.0)), Some(50));
        assert_eq!(filter_level(BRIGHTNESS, Some(-0.04), PictureOp::Offset(10.0)), Some(6));
        assert_eq!(filter_level(BRIGHTNESS, None, PictureOp::Offset(500.0)), Some(100));
        assert_eq!(filter_level(CONTRAST, None, PictureOp::Scale(1.5)), Some(150));
        assert_eq!(filter_level(CONTRAST, None, PictureOp::Scale(0.0)), Some(0));
        assert_eq!(filter_level(EDGE, None, PictureOp::Fraction(0.5)), Some(32));
    }

    #[test]
    fn offsets_use_the_driver_multiplier() {
        let fine = FilterRange { min: -1000, max: 1000, default: 0, multiplier: 0.1 };
        assert_eq!(filter_level(fine, None, PictureOp::Offset(25.0)), Some(250));
    }

    #[test]
    fn neutral_picture_maps_to_no_ops() {
        let ops = picture_ops(&CompositionPicture::default());
        assert!(ops.iter().all(|(_, op)| *op == PictureOp::None));
    }
}
