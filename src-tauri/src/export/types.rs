use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct WebcamCompose {
    pub path: PathBuf,
    pub layout: crate::overlay::OverlayLayout,
}

/// Cloud share links do not need native capture resolution.
pub const CLOUD_COMPOSE_MAX_WIDTH: u32 = 1920;
pub const CLOUD_COMPOSE_MAX_HEIGHT: u32 = 1080;

pub type ComposeProgress = Arc<dyn Fn(u32, u32) + Send + Sync>;

/// Resolved late, because CPU composes keep the source frame size while the GPU
/// encoder is always 1920x1080.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposeQuality {
    High,
    Cloud,
}

impl ComposeQuality {
    pub fn bitrate_for(self, width: u32, height: u32, fps: u32) -> u32 {
        let pixels = u64::from(width) * u64::from(height) * u64::from(fps.max(1));
        match self {
            Self::High => (pixels / 6).clamp(4_000_000, 25_000_000) as u32,
            Self::Cloud => (pixels / 10).clamp(4_000_000, 12_000_000) as u32,
        }
    }
}

#[derive(Clone)]
pub struct WebcamComposeOpts {
    pub max_width: u32,
    pub max_height: u32,
    pub quality: ComposeQuality,
    pub progress: Option<ComposeProgress>,
}

impl WebcamComposeOpts {
    pub fn native() -> Self {
        Self {
            max_width: u32::MAX,
            max_height: u32::MAX,
            quality: ComposeQuality::High,
            progress: None,
        }
    }

    pub fn cloud(progress: Option<ComposeProgress>) -> Self {
        Self {
            max_width: CLOUD_COMPOSE_MAX_WIDTH,
            max_height: CLOUD_COMPOSE_MAX_HEIGHT,
            quality: ComposeQuality::Cloud,
            progress,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposeMode {
    GpuDxgi,
    CpuNv12,
    CpuBgra,
}

impl ComposeMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::GpuDxgi => "gpu_dxgi",
            Self::CpuNv12 => "cpu_nv12",
            Self::CpuBgra => "cpu_bgra",
        }
    }
}

pub struct ComposeReport {
    pub mode: ComposeMode,
    pub decoder: String,
    pub compositor: String,
    pub encoder: String,
    pub dxgi: bool,
    pub hardware: bool,
    pub audio: String,
    pub frames: u32,
    pub written_ms: i64,
    pub elapsed_ms: u128,
}

impl ComposeReport {
    pub(crate) fn compose_fps(&self) -> f64 {
        if self.elapsed_ms == 0 {
            return 0.0;
        }
        f64::from(self.frames) * 1000.0 / self.elapsed_ms as f64
    }

    pub(crate) fn log(&self) {
        tracing::info!(
            mode = self.mode.as_str(),
            decoder = %self.decoder,
            compositor = %self.compositor,
            encoder = %self.encoder,
            dxgi = self.dxgi,
            hardware = self.hardware,
            audio = %self.audio,
            frames = self.frames,
            written_ms = self.written_ms,
            elapsed_ms = self.elapsed_ms,
            compose_fps = format!("{:.1}", self.compose_fps()),
            "webcam compose finished"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::ComposeQuality;

    /// The tier `native()` uses must keep matching the formula the CPU composes
    /// carried inline, so local exports do not change.
    #[test]
    fn high_matches_the_legacy_cpu_formula() {
        for (w, h, fps) in [(1920, 1080, 60), (1280, 720, 30), (2560, 1440, 60), (640, 480, 24)] {
            let legacy = ((u64::from(w) * u64::from(h) * u64::from(fps)) / 6)
                .clamp(4_000_000, 25_000_000) as u32;
            assert_eq!(ComposeQuality::High.bitrate_for(w, h, fps), legacy, "{w}x{h}@{fps}");
        }
    }

    #[test]
    fn cloud_caps_1080p60_at_12_mbps() {
        assert_eq!(ComposeQuality::Cloud.bitrate_for(1920, 1080, 60), 12_000_000);
        assert_eq!(ComposeQuality::High.bitrate_for(1920, 1080, 60), 20_736_000);
    }

    #[test]
    fn tiers_stay_inside_their_clamps() {
        assert_eq!(ComposeQuality::Cloud.bitrate_for(3840, 2160, 60), 12_000_000);
        assert_eq!(ComposeQuality::High.bitrate_for(3840, 2160, 60), 25_000_000);
        assert_eq!(ComposeQuality::Cloud.bitrate_for(320, 240, 24), 4_000_000);
    }

    #[test]
    fn zero_fps_does_not_divide_by_zero() {
        assert_eq!(ComposeQuality::Cloud.bitrate_for(1920, 1080, 0), 4_000_000);
    }
}
