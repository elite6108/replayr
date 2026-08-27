//! Webcam overlay placement, shape, and BGRA compositing.
//!
//! Layout is stored on `clip_sources.layout_json` and reused by the editor
//! preview and composed export. Gameplay stays the canvas; webcam is optional.

use serde::{Deserialize, Serialize};

use crate::still::StillFrame;

pub const DEFAULT_PLACEMENT: &str = "bottom-right";
pub const DEFAULT_SHAPE: &str = "rounded";
pub const DEFAULT_WIDTH: f32 = 0.22;
const MIN_WIDTH: f32 = 0.12;
const MAX_WIDTH: f32 = 0.40;
const MARGIN: f32 = 0.03;
const ROUNDED_RADIUS: f32 = 0.18;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayLayout {
    #[serde(default = "default_placement")]
    pub placement: String,
    #[serde(default = "default_shape")]
    pub shape: String,
    #[serde(default = "default_width")]
    pub width: f32,
    /// Normalized left edge (0–1). When set with `y`, overrides corner placement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f32>,
    /// Normalized top edge (0–1). When set with `x`, overrides corner placement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f32>,
}

fn default_placement() -> String {
    DEFAULT_PLACEMENT.into()
}

fn default_shape() -> String {
    DEFAULT_SHAPE.into()
}

fn default_width() -> f32 {
    DEFAULT_WIDTH
}

impl Default for OverlayLayout {
    fn default() -> Self {
        Self {
            placement: default_placement(),
            shape: default_shape(),
            width: default_width(),
            x: None,
            y: None,
        }
    }
}

impl OverlayLayout {
    pub fn new(placement: &str, shape: &str, width: f32) -> Self {
        let mut layout = Self {
            placement: placement.to_string(),
            shape: shape.to_string(),
            width,
            x: None,
            y: None,
        };
        layout.sanitize();
        layout
    }

    pub fn sanitize(&mut self) {
        self.placement = match self.placement.as_str() {
            "top-left" | "top-right" | "bottom-left" | "bottom-right" => self.placement.clone(),
            _ => default_placement(),
        };
        self.shape = match self.shape.as_str() {
            "rectangle" | "rounded" | "circle" => self.shape.clone(),
            _ => default_shape(),
        };
        self.width = if self.width.is_finite() {
            self.width.clamp(MIN_WIDTH, MAX_WIDTH)
        } else {
            default_width()
        };
        self.x = self
            .x
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 1.0));
        self.y = self
            .y
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 1.0));
        if self.x.is_none() || self.y.is_none() {
            self.x = None;
            self.y = None;
        }
    }

    pub fn from_json(raw: Option<&str>) -> Self {
        let mut layout = raw
            .and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    serde_json::from_str::<OverlayLayout>(trimmed).ok()
                }
            })
            .unwrap_or_default();
        layout.sanitize();
        layout
    }

    pub fn to_json(&self) -> String {
        let mut layout = self.clone();
        layout.sanitize();
        serde_json::to_string(&layout).unwrap_or_else(|_| {
            format!(
                r#"{{"placement":"{DEFAULT_PLACEMENT}","shape":"{DEFAULT_SHAPE}","width":{DEFAULT_WIDTH}}}"#
            )
        })
    }
}

/// Pixel box for the webcam overlay on a `canvas_w`×`canvas_h` frame.
/// `source_aspect` is width/height of the webcam frame (ignored for circle).
pub fn overlay_box(canvas_w: u32, canvas_h: u32, source_aspect: f32, layout: &OverlayLayout) -> (u32, u32, u32, u32) {
    let mut layout = layout.clone();
    layout.sanitize();
    let canvas_w = canvas_w.max(1);
    let canvas_h = canvas_h.max(1);
    let aspect = if source_aspect.is_finite() && source_aspect > 0.05 {
        source_aspect
    } else {
        16.0 / 9.0
    };
    let mut width = ((canvas_w as f32) * layout.width).round() as u32;
    width = width.clamp(1, canvas_w);
    let mut height = if layout.shape == "circle" {
        width
    } else {
        ((width as f32) / aspect).round().max(1.0) as u32
    };
    if height > canvas_h {
        height = canvas_h;
        if layout.shape == "circle" {
            width = height;
        } else {
            width = ((height as f32) * aspect).round().max(1.0) as u32;
            width = width.min(canvas_w).max(1);
        }
    }
    let margin_x = ((canvas_w as f32) * MARGIN).round() as u32;
    let margin_y = ((canvas_h as f32) * MARGIN).round() as u32;
    let max_x = canvas_w.saturating_sub(width);
    let max_y = canvas_h.saturating_sub(height);
    let (x, y) = if let (Some(nx), Some(ny)) = (layout.x, layout.y) {
        let x = ((canvas_w as f32) * nx.clamp(0.0, 1.0)).round() as u32;
        let y = ((canvas_h as f32) * ny.clamp(0.0, 1.0)).round() as u32;
        (x.min(max_x), y.min(max_y))
    } else {
        let x = match layout.placement.as_str() {
            "top-left" | "bottom-left" => margin_x.min(max_x),
            _ => max_x.saturating_sub(margin_x.min(max_x)),
        };
        let y = match layout.placement.as_str() {
            "top-left" | "top-right" => margin_y.min(max_y),
            _ => max_y.saturating_sub(margin_y.min(max_y)),
        };
        (x, y)
    };
    (x, y, width, height)
}

/// Blit `webcam` onto `canvas` using placement, shape, and width from `layout`.
/// Circle and rounded masks keep the underlying gameplay pixels.
pub fn overlay_webcam_bgra(canvas: &mut StillFrame, webcam: &StillFrame, layout: &OverlayLayout) {
    if canvas.width == 0 || canvas.height == 0 || webcam.width == 0 || webcam.height == 0 {
        return;
    }
    let aspect = webcam.width as f32 / webcam.height.max(1) as f32;
    let (origin_x, origin_y, box_w, box_h) = overlay_box(canvas.width, canvas.height, aspect, layout);
    if box_w == 0 || box_h == 0 {
        return;
    }
    let scale = (box_w as f32 / webcam.width as f32).max(box_h as f32 / webcam.height as f32);
    if scale <= 0.0 {
        return;
    }
    let src_w = (box_w as f32 / scale).min(webcam.width as f32).max(1.0);
    let src_h = (box_h as f32 / scale).min(webcam.height as f32).max(1.0);
    let src_x0 = (webcam.width as f32 - src_w) * 0.5;
    let src_y0 = (webcam.height as f32 - src_h) * 0.5;
    let radius = if layout.shape == "circle" {
        box_w.min(box_h) as f32 * 0.5
    } else if layout.shape == "rounded" {
        box_w.min(box_h) as f32 * ROUNDED_RADIUS
    } else {
        0.0
    };
    let cx = box_w as f32 * 0.5;
    let cy = box_h as f32 * 0.5;
    let canvas_pitch = canvas.pitch as usize;
    let webcam_pitch = webcam.pitch as usize;

    for dy in 0..box_h {
        for dx in 0..box_w {
            if !mask_inside(dx, dy, box_w, box_h, &layout.shape, radius, cx, cy) {
                continue;
            }
            let sx = (src_x0 + (dx as f32 + 0.5) * src_w / box_w as f32).floor() as i64;
            let sy = (src_y0 + (dy as f32 + 0.5) * src_h / box_h as f32).floor() as i64;
            if sx < 0 || sy < 0 {
                continue;
            }
            let sx = sx as u32;
            let sy = sy as u32;
            if sx >= webcam.width || sy >= webcam.height {
                continue;
            }
            let src = (sy as usize) * webcam_pitch + (sx as usize) * 4;
            let dst_x = origin_x + dx;
            let dst_y = origin_y + dy;
            if dst_x >= canvas.width || dst_y >= canvas.height {
                continue;
            }
            let dst = (dst_y as usize) * canvas_pitch + (dst_x as usize) * 4;
            if src + 4 > webcam.bgra.len() || dst + 4 > canvas.bgra.len() {
                continue;
            }
            canvas.bgra[dst] = webcam.bgra[src];
            canvas.bgra[dst + 1] = webcam.bgra[src + 1];
            canvas.bgra[dst + 2] = webcam.bgra[src + 2];
            canvas.bgra[dst + 3] = 255;
        }
    }
}

fn mask_inside(dx: u32, dy: u32, box_w: u32, box_h: u32, shape: &str, radius: f32, cx: f32, cy: f32) -> bool {
    match shape {
        "circle" => {
            let px = dx as f32 + 0.5 - cx;
            let py = dy as f32 + 0.5 - cy;
            px * px + py * py <= radius * radius
        }
        "rounded" => {
            let r = radius.max(1.0);
            let x = dx as f32 + 0.5;
            let y = dy as f32 + 0.5;
            let w = box_w as f32;
            let h = box_h as f32;
            let in_x = x >= r && x <= w - r;
            let in_y = y >= r && y <= h - r;
            if in_x || in_y {
                return x >= 0.0 && x < w && y >= 0.0 && y < h;
            }
            let cx = if x < r { r } else { w - r };
            let cy = if y < r { r } else { h - r };
            let px = x - cx;
            let py = y - cy;
            px * px + py * py <= r * r
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, color: [u8; 4]) -> StillFrame {
        let pitch = width * 4;
        let mut bgra = vec![0_u8; (pitch * height) as usize];
        for px in bgra.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
        StillFrame {
            bgra,
            width,
            height,
            pitch,
        }
    }

    fn pixel(frame: &StillFrame, x: u32, y: u32) -> [u8; 4] {
        let i = (y * frame.pitch + x * 4) as usize;
        frame.bgra[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn sanitizes_unknown_layout_values() {
        let layout = OverlayLayout::new("middle", "hexagon", 2.0);
        assert_eq!(layout.placement, "bottom-right");
        assert_eq!(layout.shape, "rounded");
        assert_eq!(layout.width, MAX_WIDTH);
        let parsed = OverlayLayout::from_json(Some(r#"{"placement":"top-left","shape":"circle","width":0.18}"#));
        assert_eq!(parsed.placement, "top-left");
        assert_eq!(parsed.shape, "circle");
        assert!((parsed.width - 0.18).abs() < f32::EPSILON);
    }

    #[test]
    fn overlay_box_bottom_right_uses_margin() {
        let layout = OverlayLayout::new("bottom-right", "rounded", 0.22);
        let (x, y, w, h) = overlay_box(1920, 1080, 16.0 / 9.0, &layout);
        assert_eq!(w, 422);
        assert_eq!(h, 237);
        assert_eq!(x, 1920 - 422 - 58);
        assert_eq!(y, 1080 - 237 - 32);
    }

    #[test]
    fn overlay_box_top_left_and_circle_is_square() {
        let layout = OverlayLayout::new("top-left", "circle", 0.20);
        let (x, y, w, h) = overlay_box(1920, 1080, 16.0 / 9.0, &layout);
        assert_eq!(w, h);
        assert_eq!(w, 384);
        assert_eq!(x, 58);
        assert_eq!(y, 32);
    }

    #[test]
    fn overlay_blits_webcam_into_the_chosen_corner() {
        let mut canvas = solid(100, 100, [0, 0, 255, 255]);
        let webcam = solid(20, 20, [0, 255, 0, 255]);
        let layout = OverlayLayout::new("bottom-right", "rectangle", 0.20);
        overlay_webcam_bgra(&mut canvas, &webcam, &layout);
        let (x, y, w, h) = overlay_box(100, 100, 1.0, &layout);
        assert_eq!(pixel(&canvas, 0, 0), [0, 0, 255, 255]);
        let inside_x = x + w / 2;
        let inside_y = y + h / 2;
        assert_eq!(pixel(&canvas, inside_x, inside_y), [0, 255, 0, 255]);
    }

    #[test]
    fn circle_keeps_gameplay_in_the_square_corners() {
        let mut canvas = solid(80, 80, [255, 0, 0, 255]);
        let webcam = solid(40, 40, [0, 255, 0, 255]);
        let layout = OverlayLayout::new("top-left", "circle", 0.40);
        overlay_webcam_bgra(&mut canvas, &webcam, &layout);
        let (x, y, w, h) = overlay_box(80, 80, 1.0, &layout);
        assert_eq!(w, h);
        assert_eq!(pixel(&canvas, x, y), [255, 0, 0, 255]);
        assert_eq!(pixel(&canvas, x + w / 2, y + h / 2), [0, 255, 0, 255]);
    }

    #[test]
    fn overlay_box_respects_free_xy() {
        let mut layout = OverlayLayout::new("bottom-right", "rounded", 0.20);
        layout.x = Some(0.10);
        layout.y = Some(0.20);
        layout.sanitize();
        let (x, y, w, _) = overlay_box(1000, 1000, 1.0, &layout);
        assert_eq!(w, 200);
        assert_eq!(x, 100);
        assert_eq!(y, 200);
    }
}
