//! Long-lived camera engine. Phase 1 enumerates devices and previews.
//! Phase 2 can write a standalone webcam MP4. Instant Replay integration
//! comes later.
//!
//! Webcam remains optional: gameplay recording never depends on this module.

mod clock;
mod color;
mod engine;
mod format;
mod safety;
mod types;

#[cfg(windows)]
mod device;
#[cfg(windows)]
mod encoder;
#[cfg(windows)]
mod preview;
#[cfg(windows)]
mod record;

#[allow(unused_imports)]
pub use clock::{overlapping_segments, segment_bounds, segment_index, CameraClockMap, SEGMENT_HNS};
#[allow(unused_imports)]
pub use engine::{estimate_storage_mb_per_minute, CameraEngine};
#[allow(unused_imports)]
pub use format::{
    estimated_mb_per_minute, pick_camera_mode, suggested_webcam_presets, webcam_bitrate_bps, CameraMode,
    CameraSubtype, RequestedMode,
};
#[allow(unused_imports)]
pub use safety::{TEST_RECORD_SECONDS, webcam_encode_should_abort};
#[allow(unused_imports)]
pub use types::{CameraAvailability, CameraDeviceInfo, CameraStatus, PreviewFrame, PreviewRequest};
