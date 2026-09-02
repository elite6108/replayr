//! Static Replayr overlay chrome. Generated once per composed session.

#![cfg(windows)]

use super::super::scene::ComposedFilterId;

pub struct OverlayBitmap {
    pub key: &'static str,
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn overlay_len(width: u32, height: u32) -> Option<usize> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
}

pub fn raster_filter_chrome(filter: ComposedFilterId, width: u32, height: u32) -> Vec<OverlayBitmap> {
    let width = width.max(2);
    let height = height.max(2);
    if overlay_len(width, height).is_none() {
        return Vec::new();
    }
    let mut out = Vec::new();
    match filter {
        ComposedFilterId::None => {}
        ComposedFilterId::Bodycam => {
            out.push(vignette(width, height, 0.82, 0.42));
            out.push(lens(width, height));
        }
        ComposedFilterId::Dashcam => {
            out.push(vignette(width, height, 0.45, 0.55));
            out.push(dash_frame(width, height));
        }
        ComposedFilterId::Vhs => {
            out.push(scanlines(width, height));
        }
        ComposedFilterId::Cinematic => {
            out.push(vignette(width, height, 0.72, 0.5));
            out.push(letterbox(width, height));
        }
    }
    out
}

fn vignette(width: u32, height: u32, strength: f32, inner: f32) -> OverlayBitmap {
    let mut bgra = vec![0u8; overlay_len(width, height).unwrap_or(0)];
    let cx = (width as f32 - 1.0) * 0.5;
    let cy = (height as f32 - 1.0) * 0.5;
    let max_r = cx.hypot(cy).max(1.0);
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let t = ((dx.hypot(dy) / max_r) - inner).clamp(0.0, 1.0) / (1.0 - inner).max(0.05);
            let alpha = (t * t * strength * 255.0).round() as u8;
            let i = ((y * width + x) * 4) as usize;
            bgra[i] = 0;
            bgra[i + 1] = 0;
            bgra[i + 2] = 0;
            bgra[i + 3] = alpha;
        }
    }
    OverlayBitmap {
        key: "vignette",
        bgra,
        width,
        height,
    }
}

fn letterbox(width: u32, height: u32) -> OverlayBitmap {
    let mut bgra = vec![0u8; overlay_len(width, height).unwrap_or(0)];
    let bar = ((height as f32) * 0.12).round() as u32;
    fill_bar(&mut bgra, width, 0, bar);
    fill_bar(&mut bgra, width, height.saturating_sub(bar), bar);
    OverlayBitmap {
        key: "letterbox",
        bgra,
        width,
        height,
    }
}

fn fill_bar(bgra: &mut [u8], width: u32, y0: u32, rows: u32) {
    for y in y0..y0.saturating_add(rows) {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            if i + 3 >= bgra.len() {
                return;
            }
            bgra[i] = 0;
            bgra[i + 1] = 0;
            bgra[i + 2] = 0;
            bgra[i + 3] = 255;
        }
    }
}

fn dash_frame(width: u32, height: u32) -> OverlayBitmap {
    let mut bgra = vec![0u8; overlay_len(width, height).unwrap_or(0)];
    let inset = 10u32.min(width / 8).min(height / 8);
    let thickness = 2u32;
    for y in inset..height.saturating_sub(inset) {
        for x in inset..width.saturating_sub(inset) {
            let edge = x < inset + thickness
                || x >= width.saturating_sub(inset + thickness)
                || y < inset + thickness
                || y >= height.saturating_sub(inset + thickness);
            if !edge {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            bgra[i] = 230;
            bgra[i + 1] = 230;
            bgra[i + 2] = 230;
            bgra[i + 3] = 72;
        }
    }
    OverlayBitmap {
        key: "dash-frame",
        bgra,
        width,
        height,
    }
}

fn lens(width: u32, height: u32) -> OverlayBitmap {
    let mut bgra = vec![0u8; overlay_len(width, height).unwrap_or(0)];
    let cx = (width as f32 - 1.0) * 0.5;
    let cy = (height as f32 - 1.0) * 0.5;
    let rx = (width as f32) * 0.42;
    let ry = (height as f32) * 0.42;
    for y in 0..height {
        for x in 0..width {
            let nx = (x as f32 - cx) / rx.max(1.0);
            let ny = (y as f32 - cy) / ry.max(1.0);
            let d = nx.hypot(ny);
            if (d - 1.0).abs() > 0.012 {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            bgra[i] = 255;
            bgra[i + 1] = 255;
            bgra[i + 2] = 255;
            bgra[i + 3] = 20;
        }
    }
    OverlayBitmap {
        key: "lens",
        bgra,
        width,
        height,
    }
}

fn scanlines(width: u32, height: u32) -> OverlayBitmap {
    let mut bgra = vec![0u8; overlay_len(width, height).unwrap_or(0)];
    for y in 0..height {
        if y % 3 != 0 {
            continue;
        }
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            bgra[i] = 255;
            bgra[i + 1] = 255;
            bgra[i + 2] = 255;
            bgra[i + 3] = 12;
        }
    }
    OverlayBitmap {
        key: "scanlines",
        bgra,
        width,
        height,
    }
}
