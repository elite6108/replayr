//! Camera mode selection and bitrate helpers.
//!
//! Native subtypes are enumerated from the device. We never upscale, never
//! invent 1080p60 if the camera cannot do it, and prefer NV12 when the same
//! size/fps is offered in more than one format.

use serde::{Deserialize, Serialize};

pub const MAX_WEBCAM_WIDTH: u32 = 1920;
pub const MAX_WEBCAM_HEIGHT: u32 = 1080;
pub const DEFAULT_WEBCAM_WIDTH: u32 = 1280;
pub const DEFAULT_WEBCAM_HEIGHT: u32 = 720;
pub const DEFAULT_WEBCAM_FPS: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CameraSubtype {
    Nv12,
    Yuy2,
    Mjpeg,
    Rgb32,
    Other,
}

impl CameraSubtype {
    pub fn as_label(self) -> &'static str {
        match self {
            Self::Nv12 => "NV12",
            Self::Yuy2 => "YUY2",
            Self::Mjpeg => "MJPEG",
            Self::Rgb32 => "RGB32",
            Self::Other => "other",
        }
    }

    pub fn from_fourcc(tag: &str) -> Self {
        match tag.to_ascii_uppercase().as_str() {
            "NV12" => Self::Nv12,
            "YUY2" | "YUYV" => Self::Yuy2,
            "MJPG" | "MJPEG" => Self::Mjpeg,
            "RGB32" | "ARGB" | "RGB" => Self::Rgb32,
            _ => Self::Other,
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Nv12 => 0,
            Self::Yuy2 => 1,
            Self::Mjpeg => 2,
            Self::Rgb32 => 3,
            Self::Other => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraMode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub native_subtype: CameraSubtype,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestedMode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl RequestedMode {
    pub fn default_720p30() -> Self {
        Self {
            width: DEFAULT_WEBCAM_WIDTH,
            height: DEFAULT_WEBCAM_HEIGHT,
            fps: DEFAULT_WEBCAM_FPS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NegotiatedMode {
    pub mode: CameraMode,
    pub reader_subtype: CameraSubtype,
    pub conversion_path: bool,
    pub native_subtype: CameraSubtype,
}

impl NegotiatedMode {
    pub fn from_native(mode: CameraMode, reader_subtype: CameraSubtype) -> Self {
        Self {
            native_subtype: mode.native_subtype,
            conversion_path: reader_subtype != mode.native_subtype,
            reader_subtype,
            mode,
        }
    }
}

/// Pick the closest mode that does not upscale past the request or 1080p.
pub fn pick_camera_mode(available: &[CameraMode], requested: RequestedMode) -> Option<CameraMode> {
    let candidates: Vec<&CameraMode> = available
        .iter()
        .filter(|mode| {
            mode.width > 0
                && mode.height > 0
                && mode.fps > 0
                && mode.width <= MAX_WEBCAM_WIDTH
                && mode.height <= MAX_WEBCAM_HEIGHT
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let exact = candidates
        .iter()
        .filter(|mode| {
            mode.width == requested.width && mode.height == requested.height && mode.fps == requested.fps
        })
        .min_by_key(|mode| mode.native_subtype.rank())
        .copied();
    if let Some(mode) = exact {
        return Some(mode.clone());
    }

    let without_upscale: Vec<&CameraMode> = candidates
        .iter()
        .copied()
        .filter(|mode| mode.width <= requested.width && mode.height <= requested.height && mode.fps <= requested.fps)
        .collect();
    let pool = if without_upscale.is_empty() {
        candidates
    } else {
        without_upscale
    };

    pool.into_iter()
        .min_by_key(|mode| {
            let dw = requested.width.abs_diff(mode.width) as u64;
            let dh = requested.height.abs_diff(mode.height) as u64;
            let df = requested.fps.abs_diff(mode.fps) as u64;
            (dw.saturating_mul(1000) + dh.saturating_mul(1000) + df, mode.native_subtype.rank())
        })
        .cloned()
}

/// Unique 720p30 / 1080p30 / 1080p60 (and native fallbacks) from what the device actually offers.
pub fn suggested_webcam_presets(available: &[CameraMode]) -> Vec<CameraMode> {
    let mut presets = Vec::new();
    for requested in [
        RequestedMode {
            width: 1280,
            height: 720,
            fps: 30,
        },
        RequestedMode {
            width: 1920,
            height: 1080,
            fps: 30,
        },
        RequestedMode {
            width: 1920,
            height: 1080,
            fps: 60,
        },
    ] {
        if let Some(mode) = pick_camera_mode(available, requested) {
            if !presets.iter().any(|existing: &CameraMode| {
                existing.width == mode.width && existing.height == mode.height && existing.fps == mode.fps
            }) {
                presets.push(mode);
            }
        }
    }
    if presets.is_empty() {
        if let Some(mode) = pick_camera_mode(available, RequestedMode::default_720p30()) {
            presets.push(mode);
        }
    }
    presets
}

pub fn webcam_bitrate_bps(width: u32, height: u32, fps: u32) -> u32 {
    let pixels = u64::from(width.max(1)) * u64::from(height.max(1));
    let rate = u64::from(fps.max(1));
    let bits = pixels.saturating_mul(rate) / 12;
    bits.clamp(2_000_000, 10_000_000) as u32
}

pub fn estimated_mb_per_minute(bitrate_bps: u32) -> u32 {
    let bytes_per_min = u64::from(bitrate_bps) * 60 / 8;
    ((bytes_per_min + 500_000) / 1_000_000).max(1) as u32
}

#[allow(dead_code)]
pub fn log_negotiated_mode(device_id: &str, negotiated: &NegotiatedMode) {
    tracing::info!(
        device_id,
        native = negotiated.native_subtype.as_label(),
        selected = format!("{}x{}@{}", negotiated.mode.width, negotiated.mode.height, negotiated.mode.fps),
        reader = negotiated.reader_subtype.as_label(),
        conversion = negotiated.conversion_path,
        "camera format negotiated"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(width: u32, height: u32, fps: u32, subtype: CameraSubtype) -> CameraMode {
        CameraMode {
            width,
            height,
            fps,
            native_subtype: subtype,
        }
    }

    #[test]
    fn prefers_nv12_when_same_mode_exists_in_several_subtypes() {
        let available = [
            mode(1280, 720, 30, CameraSubtype::Mjpeg),
            mode(1280, 720, 30, CameraSubtype::Nv12),
            mode(1280, 720, 30, CameraSubtype::Yuy2),
        ];
        let picked = pick_camera_mode(&available, RequestedMode::default_720p30()).unwrap();
        assert_eq!(picked.native_subtype, CameraSubtype::Nv12);
    }

    #[test]
    fn does_not_upscale_to_1080p() {
        let available = [mode(640, 480, 30, CameraSubtype::Nv12), mode(1280, 720, 30, CameraSubtype::Yuy2)];
        let picked = pick_camera_mode(
            &available,
            RequestedMode {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        )
        .unwrap();
        assert_eq!((picked.width, picked.height), (1280, 720));
    }

    #[test]
    fn hides_1080p60_when_the_device_cannot_do_it() {
        let available = [mode(1280, 720, 30, CameraSubtype::Nv12), mode(1920, 1080, 30, CameraSubtype::Mjpeg)];
        let presets = suggested_webcam_presets(&available);
        assert!(presets.iter().any(|mode| mode.width == 1920 && mode.fps == 30));
        assert!(!presets.iter().any(|mode| mode.fps == 60));
    }

    #[test]
    fn bitrate_stays_in_the_facecam_band() {
        assert!((2_000_000..=4_500_000).contains(&webcam_bitrate_bps(1280, 720, 30)));
        assert!((4_000_000..=6_500_000).contains(&webcam_bitrate_bps(1920, 1080, 30)));
        assert!((6_000_000..=10_000_000).contains(&webcam_bitrate_bps(1920, 1080, 60)));
        assert_eq!(estimated_mb_per_minute(4_000_000), 30);
    }

    #[test]
    fn conversion_path_is_logged_when_reader_subtype_differs() {
        let mode = mode(1280, 720, 30, CameraSubtype::Mjpeg);
        let negotiated = NegotiatedMode::from_native(mode, CameraSubtype::Nv12);
        assert!(negotiated.conversion_path);
        assert_eq!(negotiated.native_subtype, CameraSubtype::Mjpeg);
        assert_eq!(negotiated.reader_subtype, CameraSubtype::Nv12);
        assert_eq!(CameraSubtype::from_fourcc("nv12"), CameraSubtype::Nv12);
        assert_eq!(CameraSubtype::Mjpeg.as_label(), "MJPEG");
    }
}
