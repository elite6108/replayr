//! Negotiated composed-recording output size.
//!
//! One `ResolvedOutput` is chosen after the first capture frame and before the
//! compositor / encoder open. Aspect ratio is preserved at every fallback tier.

#![cfg(windows)]

use super::nv12::align_output;

/// Fallback / default canvas when negotiation must start from a known-good box.
pub const FALLBACK_1080_W: u32 = 1920;
pub const FALLBACK_1080_H: u32 = 1080;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedOutput {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub fallback_occurred: bool,
}

/// Fit `source` inside a bounding box without stretching or cropping.
pub fn fit_inside_preserving_aspect(
    source_w: u32,
    source_h: u32,
    cap_w: u32,
    cap_h: u32,
) -> (u32, u32) {
    let source_w = source_w.max(1);
    let source_h = source_h.max(1);
    let cap_w = cap_w.max(2);
    let cap_h = cap_h.max(2);
    if source_w <= cap_w && source_h <= cap_h {
        return (source_w, source_h);
    }
    let scale_w = cap_w as f64 / source_w as f64;
    let scale_h = cap_h as f64 / source_h as f64;
    let scale = scale_w.min(scale_h);
    let width = ((source_w as f64) * scale).round().max(1.0) as u32;
    let height = ((source_h as f64) * scale).round().max(1.0) as u32;
    (width.max(1), height.max(1))
}

/// Map settings resolution + source size to the requested output (aligned).
pub fn resolve_requested_size(
    resolution: &str,
    source_w: u32,
    source_h: u32,
) -> (u32, u32, &'static str) {
    let mode = match resolution.trim().to_ascii_lowercase().as_str() {
        "720p" => "720p",
        "1080p" => "1080p",
        "1440p" => "1440p",
        "4k" | "2160p" => "4k",
        "native" => "native",
        _ => "auto",
    };
    let (raw_w, raw_h) = match mode {
        "720p" => fit_inside_preserving_aspect(source_w, source_h, 1280, 720),
        "1080p" => fit_inside_preserving_aspect(source_w, source_h, 1920, 1080),
        "1440p" => fit_inside_preserving_aspect(source_w, source_h, 2560, 1440),
        "4k" => fit_inside_preserving_aspect(source_w, source_h, 3840, 2160),
        "native" => (source_w, source_h),
        // Auto: today's safe behavior — cap native inside 1080p.
        _ => fit_inside_preserving_aspect(source_w, source_h, FALLBACK_1080_W, FALLBACK_1080_H),
    };
    let (width, height) = align_output(raw_w, raw_h);
    (width, height, mode)
}

/// Candidate ladder: requested, then aspect-preserving fits into 1440p / 1080p / 720p boxes.
pub fn build_candidate_ladder(
    source_w: u32,
    source_h: u32,
    requested_w: u32,
    requested_h: u32,
) -> Vec<(u32, u32)> {
    let requested_area = u64::from(requested_w) * u64::from(requested_h);
    let mut caps = vec![
        (requested_w, requested_h),
        fit_and_align(source_w, source_h, 2560, 1440),
        fit_and_align(source_w, source_h, FALLBACK_1080_W, FALLBACK_1080_H),
        fit_and_align(source_w, source_h, 1280, 720),
    ];
    let mut out = Vec::new();
    for (w, h) in caps.drain(..) {
        if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
            continue;
        }
        let area = u64::from(w) * u64::from(h);
        // Never upscale past the requested output.
        if area > requested_area {
            continue;
        }
        if out.iter().any(|&(ow, oh)| ow == w && oh == h) {
            continue;
        }
        out.push((w, h));
    }
    if out.is_empty() {
        out.push(fit_and_align(
            source_w,
            source_h,
            FALLBACK_1080_W,
            FALLBACK_1080_H,
        ));
    }
    out
}

fn fit_and_align(source_w: u32, source_h: u32, cap_w: u32, cap_h: u32) -> (u32, u32) {
    let (w, h) = fit_inside_preserving_aspect(source_w, source_h, cap_w, cap_h);
    align_output(w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultrawide_1440_cap_preserves_aspect() {
        let (w, h) = fit_inside_preserving_aspect(3440, 1440, 2560, 1440);
        assert!(w <= 2560 && h <= 1440);
        let ratio = w as f64 / h as f64;
        let source_ratio = 3440.0 / 1440.0;
        assert!((ratio - source_ratio).abs() < 0.02);
    }

    #[test]
    fn auto_caps_4k_inside_1080() {
        let (w, h, mode) = resolve_requested_size("auto", 3840, 2160);
        assert_eq!(mode, "auto");
        assert_eq!((w, h), align_output(1920, 1080));
    }

    #[test]
    fn ladder_dedupes_and_does_not_upscale() {
        let (req_w, req_h, _) = resolve_requested_size("1080p", 1920, 1080);
        let ladder = build_candidate_ladder(1920, 1080, req_w, req_h);
        assert_eq!(ladder[0], (req_w, req_h));
        assert!(ladder.windows(2).all(|pair| {
            u64::from(pair[0].0) * u64::from(pair[0].1) >= u64::from(pair[1].0) * u64::from(pair[1].1)
        }));
    }

    #[test]
    fn native_ultrawide_requested() {
        let (w, h, mode) = resolve_requested_size("native", 3440, 1440);
        assert_eq!(mode, "native");
        assert_eq!((w, h), align_output(3440, 1440));
    }
}
