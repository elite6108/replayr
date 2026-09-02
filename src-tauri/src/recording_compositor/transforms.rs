//! Shared normalized → pixel conversion for composed session recording.
//!
//! Semantic contract (must match `src/recording/composedSemantics.ts`):
//! - `x/y/w/h` are fractions of the output canvas, origin top-left
//! - hidden sources are omitted before this runs; lock is ignored
//! - capture uses **contain** inside its dest box (letterbox)
//! - webcam uses **cover** (center-crop) inside its dest box
//! - images use **contain** inside their dest box
//! - text fills its dest box; alignment is inside the raster
//! - results are clamped, even-aligned, never negative

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum FitMode {
    /// Letterbox the source inside the dest box (game/desktop preview).
    Contain,
    /// Crop the source to fill the dest box (webcam preview).
    Cover,
    Stretch,
}

impl PixelRect {
    pub fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// Convert a normalized 0–1 transform into a pixel rectangle on `canvas`.
/// Results are clamped, even-aligned, and never negative.
pub fn dest_rect(norm: NormRect, canvas_w: u32, canvas_h: u32) -> PixelRect {
    let canvas_w = canvas_w.max(2);
    let canvas_h = canvas_h.max(2);
    let x = (norm.x as f64 * canvas_w as f64).round();
    let y = (norm.y as f64 * canvas_h as f64).round();
    let w = (norm.w as f64 * canvas_w as f64).round();
    let h = (norm.h as f64 * canvas_h as f64).round();
    clamp_rect(x, y, w, h, canvas_w, canvas_h)
}

/// Source crop that covers `dest` without stretching (`object-fit: cover`).
pub fn cover_source(src_w: u32, src_h: u32, dest_w: u32, dest_h: u32) -> PixelRect {
    let src_w = src_w.max(1);
    let src_h = src_h.max(1);
    let dest_w = dest_w.max(1);
    let dest_h = dest_h.max(1);
    let src_aspect = src_w as f64 / src_h as f64;
    let dest_aspect = dest_w as f64 / dest_h as f64;
    if src_aspect > dest_aspect {
        let w = (src_h as f64 * dest_aspect).round();
        let x = ((src_w as f64) - w) * 0.5;
        clamp_rect(x, 0.0, w, src_h as f64, src_w, src_h)
    } else {
        let h = (src_w as f64 / dest_aspect).round();
        let y = ((src_h as f64) - h) * 0.5;
        clamp_rect(0.0, y, src_w as f64, h, src_w, src_h)
    }
}

/// Dest box that contains `src` without stretching (`object-fit: contain`).
pub fn contain_dest(src_w: u32, src_h: u32, box_rect: PixelRect) -> PixelRect {
    if box_rect.is_empty() || src_w == 0 || src_h == 0 {
        return box_rect;
    }
    let src_aspect = src_w as f64 / src_h as f64;
    let box_aspect = box_rect.w as f64 / box_rect.h.max(1) as f64;
    let (w, h) = if src_aspect > box_aspect {
        let w = box_rect.w as f64;
        let h = (w / src_aspect).round();
        (w, h)
    } else {
        let h = box_rect.h as f64;
        let w = (h * src_aspect).round();
        (w, h)
    };
    let x = box_rect.x as f64 + (box_rect.w as f64 - w) * 0.5;
    let y = box_rect.y as f64 + (box_rect.h as f64 - h) * 0.5;
    clamp_rect(x, y, w, h, box_rect.x as u32 + box_rect.w, box_rect.y as u32 + box_rect.h)
        .intersect(box_rect)
}

impl PixelRect {
    fn intersect(self, other: PixelRect) -> PixelRect {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = (self.x + self.w as i32).min(other.x + other.w as i32);
        let bottom = (self.y + self.h as i32).min(other.y + other.h as i32);
        let w = (right - left).max(0) as u32;
        let h = (bottom - top).max(0) as u32;
        PixelRect {
            x: left,
            y: top,
            w: even_dim(w, 2),
            h: even_dim(h, 2),
        }
    }
}

fn clamp_rect(x: f64, y: f64, w: f64, h: f64, max_w: u32, max_h: u32) -> PixelRect {
    let max_w = max_w.max(2);
    let max_h = max_h.max(2);
    let w = w.clamp(0.0, max_w as f64);
    let h = h.clamp(0.0, max_h as f64);
    let x = x.clamp(0.0, max_w as f64);
    let y = y.clamp(0.0, max_h as f64);
    let w = w.min((max_w as f64) - x).max(0.0);
    let h = h.min((max_h as f64) - y).max(0.0);
    PixelRect {
        x: x as i32,
        y: y as i32,
        w: even_dim(w as u32, 2),
        h: even_dim(h as u32, 2),
    }
}

pub fn even_dim(value: u32, fallback: u32) -> u32 {
    let value = if value < 2 { fallback } else { value };
    (value / 2) * 2
}

pub fn even_size(width: u32, height: u32) -> (u32, u32) {
    (even_dim(width, 2), even_dim(height, 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_frame_fills_canvas() {
        let rect = dest_rect(
            NormRect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            1920,
            1080,
        );
        assert_eq!(rect, PixelRect { x: 0, y: 0, w: 1920, h: 1080 });
    }

    #[test]
    fn webcam_corner_is_deterministic() {
        let rect = dest_rect(
            NormRect {
                x: 0.75,
                y: 0.72,
                w: 0.22,
                h: 0.24,
            },
            1920,
            1080,
        );
        assert_eq!(rect.x, 1440);
        assert_eq!(rect.y, 778);
        assert_eq!(rect.w, 422);
        assert_eq!(rect.h, 260);
    }

    #[test]
    fn cover_crops_wider_source() {
        let src = cover_source(1920, 1080, 400, 400);
        assert!(src.w > 0 && src.h > 0);
        assert!(src.w as i32 + src.x <= 1920);
        assert_eq!(src.h, 1080);
    }

    #[test]
    fn contain_letterboxes_wide_source() {
        let dest = contain_dest(1920, 1080, PixelRect { x: 0, y: 0, w: 400, h: 400 });
        assert_eq!(dest.w, 400);
        assert!(dest.h < 400);
        assert!(dest.y > 0);
    }

    #[test]
    fn negative_and_overflow_clamp() {
        let rect = dest_rect(
            NormRect {
                x: -1.0,
                y: 0.9,
                w: 2.0,
                h: 0.5,
            },
            1920,
            1080,
        );
        assert!(rect.x >= 0);
        assert!(rect.y >= 0);
        assert!(rect.x as u32 + rect.w <= 1920);
        assert!(rect.y as u32 + rect.h <= 1080);
    }
}
