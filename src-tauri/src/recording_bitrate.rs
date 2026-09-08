//! Resolution-aware H.264 bitrate helpers.
//!
//! Composed recording and Instant Replay / clips share the same scaling math
//! but use different High anchors: clips need more bitrate for Baseline + fast
//! motion, while composed Medium@1080p60 stays at the proven 15 Mbps default.

/// 1080p60 pixel-rate baseline.
const BASE_PIXEL_RATE: f64 = 1920.0 * 1080.0 * 60.0;

const MIN_BPS: u32 = 4_000_000;
const MAX_BPS: u32 = 120_000_000;

const LOW_1080P60_BPS: f64 = 8_000_000.0;
const MEDIUM_1080P60_BPS: f64 = 15_000_000.0;
/// Composed High @ 1080p60 (Phase 2).
const RECORDING_HIGH_1080P60_BPS: f64 = 35_000_000.0;
/// Instant Replay / clip High @ 1080p60 — enough for high-motion Baseline encodes.
const CLIP_HIGH_1080P60_BPS: f64 = 42_000_000.0;
/// Clip Medium stays storage-conscious (top of ~15–20 Mbps guidance).
const CLIP_MEDIUM_1080P60_BPS: f64 = 18_000_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityPreset {
    Low,
    Medium,
    High,
    Custom,
}

impl QualityPreset {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Self::Low,
            "high" => Self::High,
            "custom" => Self::Custom,
            _ => Self::Medium,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Custom => "custom",
        }
    }
}

/// Resolve H.264 composed-recording bitrate from actual output geometry.
pub fn resolve_recording_bitrate(
    width: u32,
    height: u32,
    fps: u32,
    preset: QualityPreset,
    custom_kbps: u32,
) -> u32 {
    resolve_scaled_bitrate(
        width,
        height,
        fps,
        preset,
        custom_kbps,
        LOW_1080P60_BPS,
        MEDIUM_1080P60_BPS,
        RECORDING_HIGH_1080P60_BPS,
    )
}

/// Resolve Instant Replay / clip rolling-encoder bitrate from actual encode size.
///
/// Separate from composed recording so clip High can target ~40–45 Mbps @ 1080p60
/// without changing the composed Phase 2 table.
pub fn resolve_clip_bitrate(
    width: u32,
    height: u32,
    fps: u32,
    preset: QualityPreset,
    custom_kbps: u32,
) -> u32 {
    resolve_scaled_bitrate(
        width,
        height,
        fps,
        preset,
        custom_kbps,
        LOW_1080P60_BPS,
        CLIP_MEDIUM_1080P60_BPS,
        CLIP_HIGH_1080P60_BPS,
    )
}

fn resolve_scaled_bitrate(
    width: u32,
    height: u32,
    fps: u32,
    preset: QualityPreset,
    custom_kbps: u32,
    low_anchor: f64,
    medium_anchor: f64,
    high_anchor: f64,
) -> u32 {
    if matches!(preset, QualityPreset::Custom) {
        return clamp_bps(custom_kbps.saturating_mul(1000));
    }

    let width = width.max(2);
    let height = height.max(2);
    let fps = fps.max(1);
    let scale = pixel_scale(width, height, fps);
    let (anchor, exponent, max_mult) = match preset {
        QualityPreset::Low => (low_anchor, 0.92_f64, 4.0_f64),
        QualityPreset::Medium => (medium_anchor, 0.90_f64, 4.0_f64),
        QualityPreset::High => (high_anchor, 0.95_f64, 3.0_f64),
        QualityPreset::Custom => unreachable!(),
    };
    let mult = scale.powf(exponent).clamp(0.25, max_mult);
    let bps = (anchor * mult).round();
    clamp_bps(if bps.is_finite() && bps > 0.0 {
        bps as u32
    } else {
        medium_anchor as u32
    })
}

fn pixel_scale(width: u32, height: u32, fps: u32) -> f64 {
    let rate = f64::from(width) * f64::from(height) * f64::from(fps.max(1));
    (rate / BASE_PIXEL_RATE).max(0.25)
}

fn clamp_bps(bps: u32) -> u32 {
    bps.clamp(MIN_BPS, MAX_BPS)
}

pub fn bitrate_mbps(bps: u32) -> f64 {
    f64::from(bps) / 1_000_000.0
}

/// Approximate MB/minute for UI copy (`bitrate_mbps * 7.5`).
pub fn estimated_mb_per_minute(bps: u32) -> u32 {
    let mb = bitrate_mbps(bps) * 7.5;
    if mb.is_finite() && mb > 0.0 {
        mb.round().max(1.0) as u32
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mbps(width: u32, height: u32, fps: u32, preset: QualityPreset) -> f64 {
        bitrate_mbps(resolve_recording_bitrate(width, height, fps, preset, 0))
    }

    #[test]
    fn medium_1080p60_stays_near_15() {
        let bps = resolve_recording_bitrate(1920, 1080, 60, QualityPreset::Medium, 0);
        assert_eq!(bps, 15_000_000);
    }

    #[test]
    fn low_high_1080p60_anchors() {
        assert_eq!(
            resolve_recording_bitrate(1920, 1080, 60, QualityPreset::Low, 0),
            8_000_000
        );
        assert_eq!(
            resolve_recording_bitrate(1920, 1080, 60, QualityPreset::High, 0),
            35_000_000
        );
    }

    #[test]
    fn clip_high_1080p60_is_about_42() {
        assert_eq!(
            resolve_clip_bitrate(1920, 1080, 60, QualityPreset::High, 0),
            42_000_000
        );
        assert_eq!(
            resolve_clip_bitrate(1920, 1080, 60, QualityPreset::Medium, 0),
            18_000_000
        );
    }

    #[test]
    fn clip_high_scales_above_1080() {
        let h1080 = resolve_clip_bitrate(1920, 1080, 60, QualityPreset::High, 0);
        let h1440 = resolve_clip_bitrate(2560, 1440, 60, QualityPreset::High, 0);
        let h4k = resolve_clip_bitrate(3840, 2160, 60, QualityPreset::High, 0);
        assert!(h1440 > h1080);
        assert!(h4k > h1440);
        assert!(h4k <= MAX_BPS);
        // Soft cap keeps 4K High near ~100–120 Mbps guidance.
        assert!(
            (90_000_000..=120_000_000).contains(&h4k),
            "clip 4k high={h4k}"
        );
    }

    #[test]
    fn composed_high_unchanged_by_clip_anchors() {
        assert_eq!(
            resolve_recording_bitrate(1920, 1080, 60, QualityPreset::High, 0),
            35_000_000
        );
    }

    #[test]
    fn scales_up_for_1440_and_4k() {
        let m1080 = mbps(1920, 1080, 60, QualityPreset::Medium);
        let m1440 = mbps(2560, 1440, 60, QualityPreset::Medium);
        let m4k = mbps(3840, 2160, 60, QualityPreset::Medium);
        assert!(m1440 > m1080);
        assert!(m4k > m1440);
        assert!((25.0..40.0).contains(&m1440), "medium 1440 got {m1440}");
        assert!((45.0..65.0).contains(&m4k), "medium 4k got {m4k}");

        let h4k = mbps(3840, 2160, 60, QualityPreset::High);
        assert!((80.0..=120.0).contains(&h4k), "high 4k got {h4k}");
    }

    #[test]
    fn fps_affects_budget() {
        let p60 = resolve_recording_bitrate(1920, 1080, 60, QualityPreset::Medium, 0);
        let p30 = resolve_recording_bitrate(1920, 1080, 30, QualityPreset::Medium, 0);
        assert!(p30 < p60);
    }

    #[test]
    fn custom_exact_and_clamped() {
        assert_eq!(
            resolve_recording_bitrate(1920, 1080, 60, QualityPreset::Custom, 22_000),
            22_000_000
        );
        assert_eq!(
            resolve_recording_bitrate(1920, 1080, 60, QualityPreset::Custom, 100),
            MIN_BPS
        );
        assert_eq!(
            resolve_recording_bitrate(3840, 2160, 60, QualityPreset::Custom, 500_000),
            MAX_BPS
        );
    }

    #[test]
    fn fallback_1080_not_4k_budget() {
        let bps = resolve_recording_bitrate(1920, 1080, 60, QualityPreset::High, 0);
        assert_eq!(bps, 35_000_000);
    }
}
