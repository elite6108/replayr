use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::format::{CameraSubtype, NegotiatedMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraAvailability {
    Idle,
    Ready,
    Previewing,
    Recording,
    Disconnected,
    PermissionDenied,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatus {
    pub enabled: bool,
    pub availability: CameraAvailability,
    pub device_id: String,
    pub device_name: String,
    pub message: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub native_subtype: Option<CameraSubtype>,
    pub reader_subtype: Option<CameraSubtype>,
    pub conversion_path: bool,
    pub timestamp_fallback: bool,
    pub estimated_mb_per_minute: u32,
    #[serde(default)]
    pub recording: bool,
    /// True while Instant Replay owns the webcam rolling buffer (not a settings test record).
    #[serde(default)]
    pub rolling: bool,
    #[serde(default)]
    pub encoder_name: String,
    #[serde(default)]
    pub encoder_hardware: bool,
    #[serde(default)]
    pub software_fallback: bool,
    #[serde(default)]
    pub dropped_frames: u32,
    #[serde(default)]
    pub written_frames: u32,
    #[serde(default)]
    pub test_path: String,
    #[serde(default)]
    pub session_clock: bool,
    #[serde(default)]
    pub session_skew_ms: i64,
}

impl CameraStatus {
    pub fn idle() -> Self {
        Self {
            enabled: false,
            availability: CameraAvailability::Idle,
            device_id: String::new(),
            device_name: String::new(),
            message: String::new(),
            width: 0,
            height: 0,
            fps: 0,
            native_subtype: None,
            reader_subtype: None,
            conversion_path: false,
            timestamp_fallback: false,
            estimated_mb_per_minute: 0,
            recording: false,
            rolling: false,
            encoder_name: String::new(),
            encoder_hardware: false,
            software_fallback: false,
            dropped_frames: 0,
            written_frames: 0,
            test_path: String::new(),
            session_clock: false,
            session_skew_ms: 0,
        }
    }

    pub fn unsupported() -> Self {
        Self {
            availability: CameraAvailability::Unsupported,
            message: "Camera capture is available on Windows.".into(),
            ..Self::idle()
        }
    }
}

/// Latest encoded camera preview frame.
#[derive(Debug, Clone)]
pub struct PreviewJpeg {
    pub bytes: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
    pub mirrored: bool,
    pub frame_id: u64,
}

/// Metadata ahead of the JPEG bytes on the binary camera preview channel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHeader {
    pub width: u32,
    pub height: u32,
    pub mirrored: bool,
    pub frame_id: u64,
    pub mime_type: String,
}

impl PreviewHeader {
    pub fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            mirrored: false,
            frame_id: 0,
            mime_type: "image/jpeg".into(),
        }
    }
}

/// One-frame slot shared by the camera preview thread and long-poll waiters.
#[derive(Default)]
pub struct PreviewSlot {
    latest: Mutex<Option<PreviewJpeg>>,
    cv: Condvar,
    closed: AtomicBool,
}

impl PreviewSlot {
    pub fn publish(&self, frame: PreviewJpeg) {
        if let Ok(mut slot) = self.latest.lock() {
            *slot = Some(frame);
        }
        self.cv.notify_all();
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    /// Waits until a frame newer than `after` lands, the timeout passes, or the slot closes.
    /// Bytes are returned only for a newer frame.
    pub fn wait(&self, after: u64, timeout: Duration) -> (PreviewHeader, Option<Arc<[u8]>>) {
        let deadline = Instant::now() + timeout;
        let latest = (|| {
            let mut slot = self.latest.lock().ok()?;
            loop {
                if slot.as_ref().is_some_and(|frame| frame.frame_id > after) {
                    break;
                }
                let now = Instant::now();
                if now >= deadline || self.closed.load(Ordering::SeqCst) {
                    break;
                }
                slot = self.cv.wait_timeout(slot, deadline - now).ok()?.0;
            }
            slot.clone()
        })();
        let Some(frame) = latest else {
            return (PreviewHeader::empty(), None);
        };
        let header = PreviewHeader {
            width: frame.width,
            height: frame.height,
            mirrored: frame.mirrored,
            frame_id: frame.frame_id,
            mime_type: "image/jpeg".into(),
        };
        let bytes = (frame.frame_id > after).then_some(frame.bytes);
        (header, bytes)
    }
}

/// Hardware camera controls Replayr exposes, by settings name.
pub const CAMERA_CONTROL_NAMES: &[&str] = &["exposure", "focus", "whiteBalance", "backlight", "gain", "powerLine"];

pub fn is_camera_control_name(name: &str) -> bool {
    CAMERA_CONTROL_NAMES.contains(&name)
}

/// Webcam preview pace and size. Does not change the recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewSmoothness {
    /// Every camera frame, 640 px wide.
    Smooth,
    /// Up to 30 fps, 960 px wide.
    Balanced,
    /// Up to 30 fps, 1280 px wide.
    Sharp,
}

impl PreviewSmoothness {
    pub fn parse(value: &str) -> Self {
        match value {
            "smooth" => Self::Smooth,
            "sharp" => Self::Sharp,
            _ => Self::Balanced,
        }
    }

    pub fn max_width(self) -> u32 {
        match self {
            Self::Smooth => 640,
            Self::Balanced => 960,
            Self::Sharp => 1280,
        }
    }

    pub fn jpeg_quality(self) -> u8 {
        match self {
            Self::Smooth => 85,
            Self::Balanced => 88,
            Self::Sharp => 90,
        }
    }

    /// Minimum gap between preview frames. A quarter under the frame period, so camera
    /// jitter does not drop every other frame.
    pub fn min_gap(self, camera_fps: u32) -> Duration {
        let fps = match self {
            Self::Smooth => camera_fps.clamp(1, 60),
            _ => camera_fps.clamp(1, 30),
        };
        Duration::from_micros(750_000 / u64::from(fps))
    }
}

#[derive(Debug, Clone)]
pub struct PreviewRequest {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
    pub smoothness: PreviewSmoothness,
}

impl PreviewRequest {
    pub fn sanitize(self) -> Result<Self, String> {
        let device_id = sanitize_device_id(&self.device_id)?;
        if device_id.is_empty() {
            return Err("Choose a camera first.".into());
        }
        Ok(Self {
            device_id,
            width: self.width.clamp(160, 1920),
            height: self.height.clamp(120, 1080),
            fps: match self.fps {
                60 => 60,
                24 => 24,
                15 => 15,
                _ => 30,
            },
            mirror: self.mirror,
            smoothness: self.smoothness,
        })
    }
}

pub fn sanitize_device_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.len() > 512 {
        return Err("That camera id is not valid.".into());
    }
    if trimmed.contains('\0') || trimmed.contains("..") {
        return Err("That camera id is not valid.".into());
    }
    Ok(trimmed.to_string())
}

#[allow(dead_code)]
pub fn apply_negotiated(status: &mut CameraStatus, negotiated: &NegotiatedMode) {
    status.width = negotiated.mode.width;
    status.height = negotiated.mode.height;
    status.fps = negotiated.mode.fps;
    status.native_subtype = Some(negotiated.native_subtype);
    status.reader_subtype = Some(negotiated.reader_subtype);
    status.conversion_path = negotiated.conversion_path;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(frame_id: u64) -> PreviewJpeg {
        PreviewJpeg {
            bytes: Arc::from(vec![frame_id as u8]),
            width: 2,
            height: 2,
            mirrored: false,
            frame_id,
        }
    }

    #[test]
    fn preview_slot_returns_bytes_only_for_a_newer_frame() {
        let slot = PreviewSlot::default();
        slot.publish(jpeg(4));
        let (header, bytes) = slot.wait(3, Duration::from_millis(5));
        assert_eq!(header.frame_id, 4);
        assert_eq!(bytes.as_deref(), Some(&[4_u8][..]));
        let (header, bytes) = slot.wait(4, Duration::from_millis(5));
        assert_eq!(header.frame_id, 4);
        assert!(bytes.is_none());
    }

    #[test]
    fn preview_slot_wakes_on_publish_and_close() {
        let slot = Arc::new(PreviewSlot::default());
        let writer = Arc::clone(&slot);
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            writer.publish(jpeg(1));
        });
        let started = Instant::now();
        let (header, bytes) = slot.wait(0, Duration::from_secs(2));
        handle.join().expect("writer");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(header.frame_id, 1);
        assert!(bytes.is_some());

        slot.close();
        let started = Instant::now();
        let (_, bytes) = slot.wait(1, Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(bytes.is_none());
    }

    #[test]
    fn smooth_preview_keeps_every_frame_of_a_sixty_fps_camera() {
        assert!(PreviewSmoothness::Smooth.min_gap(60) < Duration::from_micros(16_667));
        assert!(PreviewSmoothness::Balanced.min_gap(60) > Duration::from_micros(16_667));
        assert!(PreviewSmoothness::Balanced.min_gap(30) < Duration::from_micros(33_333));
        assert_eq!(PreviewSmoothness::parse("nope"), PreviewSmoothness::Balanced);
    }

    #[test]
    fn rejects_path_injection_in_device_id() {
        assert!(sanitize_device_id("..\\evil").is_err());
        assert!(sanitize_device_id("ok-cam").is_ok());
        assert!(sanitize_device_id(&"x".repeat(600)).is_err());
    }
}
