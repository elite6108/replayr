//! Webcam encode stays subordinate to gameplay. If software H.264 falls
//! behind, we abort the *webcam* recording — never the gameplay clip.

/// Drop-oldest queue depth. About 200 ms at 30 FPS.
#[allow(dead_code)]
pub const QUEUE_CAP: usize = 6;

/// Test recordings stay short so a stuck driver cannot fill the disk.
#[allow(dead_code)]
pub const TEST_RECORD_SECONDS: u32 = 8;

/// Ignore drop ratio until we have this many captured frames (warmup).
const MIN_FRAMES_BEFORE_ABORT: u32 = 30;

/// Abort webcam encode if more than 35% of frames were dropped.
const DROP_ABORT_PERCENT: u32 = 35;

/// Software encode is over budget if a write takes longer than this.
#[allow(dead_code)]
pub const SOFTWARE_WRITE_BUDGET: std::time::Duration = std::time::Duration::from_millis(80);

/// Abort after this many over-budget software writes in a row.
#[allow(dead_code)]
pub const SOFTWARE_STALL_LIMIT: u32 = 12;

pub fn webcam_encode_should_abort(dropped: u32, seen: u32) -> bool {
    if seen < MIN_FRAMES_BEFORE_ABORT {
        return false;
    }
    dropped.saturating_mul(100) / seen.max(1) >= DROP_ABORT_PERCENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmup_does_not_abort() {
        assert!(!webcam_encode_should_abort(10, 20));
    }

    #[test]
    fn heavy_drops_abort_webcam_only() {
        assert!(webcam_encode_should_abort(40, 100));
        assert!(!webcam_encode_should_abort(10, 100));
    }
}
