//! Straight-BGRA layer compositing for the offline clip burn.
//!
//! Every burn layer is straight (non-premultiplied) BGRA with real per-pixel alpha — glyph
//! coverage from the GDI rasterizer, PNG alpha, gradient falloff in the filter chrome. See the
//! invariant documented in `recording_compositor/sources/mod.rs`.

use crate::recording_compositor::scene::{
    ValidatedComposition, ValidatedImage, ValidatedLayer, ValidatedText,
};
use crate::recording_compositor::sources::{image::load_image, overlay::raster_filter_chrome, text};
use crate::recording_compositor::transforms::{
    crop_then_contain, dest_rect, PixelRect,
};

/// Alpha-blend a straight-BGRA source over a straight-BGRA destination canvas.
///
/// `out.rgb = src.rgb * a + dst.rgb * (1 - a)` where `a = src.a * opacity`.
///
/// Never premultiplies, never colour-keys, and never flattens to black: opaque black text and
/// dark PNG pixels have to survive this, which is exactly what colour-keying would destroy.
pub fn blend_straight_bgra(
    canvas: &mut [u8],
    canvas_w: u32,
    canvas_h: u32,
    src: &[u8],
    src_w: u32,
    src_h: u32,
    at: PixelRect,
    opacity: f32,
) {
    if src_w == 0 || src_h == 0 || opacity <= 0.0 {
        return;
    }
    let opacity = opacity.clamp(0.0, 1.0);
    for row in 0..src_h {
        let y = at.y + row as i32;
        if y < 0 || y >= canvas_h as i32 {
            continue;
        }
        for col in 0..src_w {
            let x = at.x + col as i32;
            if x < 0 || x >= canvas_w as i32 {
                continue;
            }
            let si = ((row * src_w + col) * 4) as usize;
            let di = ((y as u32 * canvas_w + x as u32) * 4) as usize;
            if si + 3 >= src.len() || di + 3 >= canvas.len() {
                continue;
            }
            let alpha = (src[si + 3] as f32 / 255.0) * opacity;
            if alpha <= 0.0 {
                continue;
            }
            if alpha >= 1.0 {
                canvas[di] = src[si];
                canvas[di + 1] = src[si + 1];
                canvas[di + 2] = src[si + 2];
                canvas[di + 3] = 255;
                continue;
            }
            for channel in 0..3 {
                let s = src[si + channel] as f32;
                let d = canvas[di + channel] as f32;
                canvas[di + channel] = (s * alpha + d * (1.0 - alpha)).round().clamp(0.0, 255.0) as u8;
            }
            canvas[di + 3] = 255;
        }
    }
}

/// Nearest-neighbour scale of a straight-BGRA buffer, alpha preserved.
///
/// `still::scale_bgra_to` works on `StillFrame`, which carries no alpha channel semantics; the
/// burn needs alpha to survive the resize or every overlay would come out on a black box.
pub fn scale_straight_bgra(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dst_w as usize) * (dst_h as usize) * 4];
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return out;
    }
    for y in 0..dst_h {
        let sy = ((y as u64 * src_h as u64) / dst_h as u64).min(src_h as u64 - 1) as u32;
        for x in 0..dst_w {
            let sx = ((x as u64 * src_w as u64) / dst_w as u64).min(src_w as u64 - 1) as u32;
            let si = ((sy * src_w + sx) * 4) as usize;
            let di = ((y * dst_w + x) * 4) as usize;
            if si + 3 < src.len() && di + 3 < out.len() {
                out[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
    }
    out
}

/// Crop a straight-BGRA buffer to a sub-rectangle.
pub fn crop_straight_bgra(src: &[u8], src_w: u32, src_h: u32, rect: PixelRect) -> (Vec<u8>, u32, u32) {
    let x0 = rect.x.max(0) as u32;
    let y0 = rect.y.max(0) as u32;
    let w = rect.w.min(src_w.saturating_sub(x0));
    let h = rect.h.min(src_h.saturating_sub(y0));
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    for row in 0..h {
        let si = (((y0 + row) * src_w + x0) * 4) as usize;
        let di = ((row * w) * 4) as usize;
        let len = (w * 4) as usize;
        if si + len <= src.len() && di + len <= out.len() {
            out[di..di + len].copy_from_slice(&src[si..si + len]);
        }
    }
    (out, w, h)
}

/// A full-canvas straight-BGRA sheet holding every layer that does not change between frames.
///
/// Images, text, filter chrome and the REC indicator are all static for the length of a clip, so
/// they are rasterized once here and cost one alpha blend per frame instead of a full re-layout.
pub struct StaticSheet {
    pub bgra: Vec<u8>,
    /// False when nothing was drawn, so the per-frame blend can be skipped entirely.
    pub occupied: bool,
    /// Bounding box of everything drawn into the sheet.
    ///
    /// A clip is thousands of frames, and most overlays cover a small part of the canvas. Without
    /// this the burn would alpha-scan every pixel of every frame just to find a corner logo.
    pub bounds: PixelRect,
}

/// Accumulates the drawn region so the per-frame blend only touches pixels that matter.
struct Bounds {
    min_x: i64,
    min_y: i64,
    max_x: i64,
    max_y: i64,
}

impl Bounds {
    fn new() -> Self {
        Self { min_x: i64::MAX, min_y: i64::MAX, max_x: i64::MIN, max_y: i64::MIN }
    }

    fn add(&mut self, rect: PixelRect) {
        if rect.is_empty() {
            return;
        }
        self.min_x = self.min_x.min(rect.x as i64);
        self.min_y = self.min_y.min(rect.y as i64);
        self.max_x = self.max_x.max(rect.x as i64 + rect.w as i64);
        self.max_y = self.max_y.max(rect.y as i64 + rect.h as i64);
    }

    fn resolve(&self, canvas_w: u32, canvas_h: u32) -> PixelRect {
        if self.max_x <= self.min_x || self.max_y <= self.min_y {
            return PixelRect { x: 0, y: 0, w: 0, h: 0 };
        }
        let x = self.min_x.clamp(0, canvas_w as i64);
        let y = self.min_y.clamp(0, canvas_h as i64);
        let right = self.max_x.clamp(0, canvas_w as i64);
        let bottom = self.max_y.clamp(0, canvas_h as i64);
        PixelRect {
            x: x as i32,
            y: y as i32,
            w: (right - x).max(0) as u32,
            h: (bottom - y).max(0) as u32,
        }
    }
}

pub fn build_static_sheet(
    spec: &ValidatedComposition,
    canvas_w: u32,
    canvas_h: u32,
    hud_scale: f32,
) -> StaticSheet {
    let mut sheet = vec![0u8; (canvas_w as usize) * (canvas_h as usize) * 4];
    let mut occupied = false;
    let mut bounds = Bounds::new();

    // Scene sources by z-order. Chrome and HUD are applied after, regardless of their `order` —
    // the fixed pipeline in composedSemantics.ts and the preview CSS both pin them on top.
    let mut ordered: Vec<&ValidatedLayer> = spec
        .layers
        .iter()
        .filter(|layer| matches!(layer, ValidatedLayer::Image(_) | ValidatedLayer::Text(_)))
        .collect();
    ordered.sort_by_key(|layer| layer.order(spec));

    for layer in ordered {
        let drawn = match layer {
            ValidatedLayer::Image(image) => draw_image(&mut sheet, canvas_w, canvas_h, image),
            ValidatedLayer::Text(item) => draw_text(&mut sheet, canvas_w, canvas_h, item),
            _ => None,
        };
        if let Some(rect) = drawn {
            bounds.add(rect);
            occupied = true;
        }
    }

    for bitmap in raster_filter_chrome(spec.filter, canvas_w, canvas_h) {
        let rect = PixelRect { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
        blend_straight_bgra(
            &mut sheet,
            canvas_w,
            canvas_h,
            &bitmap.bgra,
            bitmap.width,
            bitmap.height,
            rect,
            1.0,
        );
        // Chrome is full-canvas by definition, so this pins the bounds wide open.
        bounds.add(rect);
        occupied = true;
    }

    if let Some(hud) = spec.hud.as_ref() {
        if hud.rec {
            if let Some(rect) =
                draw_hud_line(&mut sheet, canvas_w, canvas_h, "hud-rec", "REC", REC_COLOR, hud_scale, spec)
            {
                bounds.add(rect);
                occupied = true;
            }
        }
        if let Some(label) = hud.label.as_deref() {
            if let Some(rect) =
                draw_hud_line(&mut sheet, canvas_w, canvas_h, "hud-label", label, LABEL_COLOR, hud_scale, spec)
            {
                bounds.add(rect);
                occupied = true;
            }
        }
    }

    StaticSheet {
        bgra: sheet,
        occupied,
        bounds: bounds.resolve(canvas_w, canvas_h),
    }
}

/// `.preview-rec` is #f2d0d0; BGRA byte order.
pub const REC_COLOR: [u8; 4] = [0xd0, 0xd0, 0xf2, 0xff];
/// `.preview-hud-label` inherits the panel text colour.
pub const LABEL_COLOR: [u8; 4] = [0xe4, 0xe4, 0xe4, 0xff];
/// `.preview-timestamp` is #d7e4c8.
pub const CLOCK_COLOR: [u8; 4] = [0xc8, 0xe4, 0xd7, 0xff];

/// CSS sizes the HUD at a fixed 12px on a ~640px-wide preview. Scale it with the real canvas so
/// REC and the timestamp stay proportional from 1080p to 4K.
/// Keep in step with `.preview-rec` / `.preview-timestamp` in styles/recording-preview.css.
pub const HUD_BASE_HEIGHT: f32 = 720.0;
pub const HUD_FONT_PX: f32 = 12.0;

pub fn hud_scale_for(canvas_h: u32) -> f32 {
    (canvas_h as f32 / HUD_BASE_HEIGHT).max(1.0)
}

fn draw_image(
    sheet: &mut [u8],
    canvas_w: u32,
    canvas_h: u32,
    image: &ValidatedImage,
) -> Option<PixelRect> {
    // A moved or deleted PNG must never cost the user their clip: skip this layer only.
    let decoded = match load_image(image) {
        Ok(decoded) => decoded,
        Err(error) => {
            tracing::warn!(%error, id = %image.id, "clip burn skipped an image layer");
            return None;
        }
    };
    let box_rect = dest_rect(image.transform, canvas_w, canvas_h);
    let (dest, src) = crop_then_contain(image.crop, decoded.width, decoded.height, box_rect);
    if dest.is_empty() {
        return None;
    }
    let (region, region_w, region_h) = match src {
        Some(rect) => crop_straight_bgra(&decoded.bgra, decoded.width, decoded.height, rect),
        None => (decoded.bgra, decoded.width, decoded.height),
    };
    let scaled = scale_straight_bgra(&region, region_w, region_h, dest.w, dest.h);
    blend_straight_bgra(sheet, canvas_w, canvas_h, &scaled, dest.w, dest.h, dest, image.opacity);
    Some(dest)
}

fn draw_text(
    sheet: &mut [u8],
    canvas_w: u32,
    canvas_h: u32,
    item: &ValidatedText,
) -> Option<PixelRect> {
    let box_rect = dest_rect(item.transform, canvas_w, canvas_h);
    if box_rect.is_empty() {
        return None;
    }
    let (bw, bh) = text::clamp_text_raster(box_rect.w, box_rect.h, canvas_w, canvas_h);
    let raster = match text::raster_text(item, bw, bh) {
        Ok(raster) => raster,
        Err(error) => {
            tracing::warn!(%error, id = %item.id, "clip burn skipped a text layer");
            return None;
        }
    };
    let at = PixelRect { x: box_rect.x, y: box_rect.y, w: raster.width, h: raster.height };
    blend_straight_bgra(
        sheet,
        canvas_w,
        canvas_h,
        &raster.bgra,
        raster.width,
        raster.height,
        at,
        item.opacity,
    );
    Some(at)
}

fn draw_hud_line(
    sheet: &mut [u8],
    canvas_w: u32,
    canvas_h: u32,
    id: &str,
    body: &str,
    color: [u8; 4],
    scale: f32,
    spec: &ValidatedComposition,
) -> Option<PixelRect> {
    let (raster, at) = render_hud_line(canvas_w, canvas_h, id, body, color, scale, spec)?;
    blend_straight_bgra(sheet, canvas_w, canvas_h, &raster.bgra, raster.width, raster.height, at, 1.0);
    Some(at)
}

/// Rasterize and place one HUD line.
///
/// Shared with the per-frame timestamp, which cannot join the static sheet because it ticks once
/// a second.
pub fn render_hud_line(
    canvas_w: u32,
    canvas_h: u32,
    id: &str,
    body: &str,
    color: [u8; 4],
    scale: f32,
    spec: &ValidatedComposition,
) -> Option<(text::RasterText, PixelRect)> {
    let size = (HUD_FONT_PX * scale).round().max(8.0) as u32;
    let box_w = ((body.chars().count() as f32 + 2.0) * size as f32 * 0.7).round() as u32;
    let box_h = (size as f32 * 1.8).round() as u32;
    let (bw, bh) = text::clamp_text_raster(box_w, box_h, canvas_w, canvas_h);
    let raster = match text::raster_hud_line(
        id,
        body,
        color,
        size,
        crate::recording_compositor::scene::TextAlign::Left,
        bw,
        bh,
    ) {
        Ok(raster) => raster,
        Err(error) => {
            tracing::warn!(%error, id, "clip burn skipped a HUD line");
            return None;
        }
    };
    let at = crate::recording_compositor::compositor::hud_rect(
        id,
        raster.width,
        raster.height,
        canvas_w,
        canvas_h,
        spec.hud.as_ref(),
    );
    Some((raster, at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(w: u32, h: u32) -> Vec<u8> {
        vec![255u8; (w * h * 4) as usize]
    }

    #[test]
    fn blend_straight_bgra_preserves_opaque_black() {
        // Opaque black text over white must land as black, not be colour-keyed away.
        let mut canvas = white(2, 1);
        let src = [0u8, 0, 0, 255, 0, 0, 0, 255];
        blend_straight_bgra(&mut canvas, 2, 1, &src, 2, 1, PixelRect { x: 0, y: 0, w: 2, h: 1 }, 1.0);
        assert_eq!(&canvas[0..4], &[0, 0, 0, 255]);
        assert_eq!(&canvas[4..8], &[0, 0, 0, 255]);
    }

    #[test]
    fn blend_straight_bgra_respects_alpha_and_opacity() {
        let mut canvas = white(1, 1);
        // Half-alpha black at full opacity lands mid-grey.
        let src = [0u8, 0, 0, 128];
        blend_straight_bgra(&mut canvas, 1, 1, &src, 1, 1, PixelRect { x: 0, y: 0, w: 1, h: 1 }, 1.0);
        assert!((120..=135).contains(&canvas[0]), "got {}", canvas[0]);

        // Fully transparent pixels leave the canvas untouched.
        let mut canvas = white(1, 1);
        let src = [0u8, 0, 0, 0];
        blend_straight_bgra(&mut canvas, 1, 1, &src, 1, 1, PixelRect { x: 0, y: 0, w: 1, h: 1 }, 1.0);
        assert_eq!(&canvas[0..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn blend_straight_bgra_clips_outside_the_canvas() {
        let mut canvas = white(2, 2);
        let src = [0u8, 0, 0, 255];
        // Negative and past-edge placements must not panic or wrap.
        blend_straight_bgra(&mut canvas, 2, 2, &src, 1, 1, PixelRect { x: -5, y: 0, w: 1, h: 1 }, 1.0);
        blend_straight_bgra(&mut canvas, 2, 2, &src, 1, 1, PixelRect { x: 9, y: 9, w: 1, h: 1 }, 1.0);
        assert!(canvas.iter().all(|byte| *byte == 255));
    }

    #[test]
    fn hud_scale_never_shrinks_below_one() {
        assert_eq!(hud_scale_for(720), 1.0);
        assert_eq!(hud_scale_for(360), 1.0);
        assert_eq!(hud_scale_for(1440), 2.0);
    }
}
