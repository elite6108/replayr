/// Fit inside `max_w`×`max_h` without upscaling. Even sizes for H.264.
pub fn fit_compose_size(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let width = width.max(2);
    let height = height.max(2);
    if width <= max_w && height <= max_h {
        return (width & !1, height & !1);
    }
    let scale = (f64::from(max_w) / f64::from(width)).min(f64::from(max_h) / f64::from(height));
    let w = ((f64::from(width) * scale).round() as u32).max(2) & !1;
    let h = ((f64::from(height) * scale).round() as u32).max(2) & !1;
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::fit_compose_size;

    #[test]
    fn fit_compose_size_keeps_1080p() {
        assert_eq!(fit_compose_size(1920, 1080, 1920, 1080), (1920, 1080));
    }

    #[test]
    fn fit_compose_size_scales_1440p_and_4k() {
        assert_eq!(fit_compose_size(2560, 1440, 1920, 1080), (1920, 1080));
        assert_eq!(fit_compose_size(3840, 2160, 1920, 1080), (1920, 1080));
    }

    #[test]
    fn fit_compose_size_does_not_upscale() {
        assert_eq!(fit_compose_size(1280, 720, 1920, 1080), (1280, 720));
    }
}
