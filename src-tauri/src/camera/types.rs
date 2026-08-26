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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    pub mirrored: bool,
}

#[derive(Debug, Clone)]
pub struct PreviewRequest {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
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

    #[test]
    fn rejects_path_injection_in_device_id() {
        assert!(sanitize_device_id("..\\evil").is_err());
        assert!(sanitize_device_id("ok-cam").is_ok());
        assert!(sanitize_device_id(&"x".repeat(600)).is_err());
    }
}
