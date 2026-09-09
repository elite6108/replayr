//! Requested settings, the running writer's target, codec readback, and measured
//! segment output are deliberately separate. A settings save is not an ack.
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IrEncoderStatus {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub requested_bitrate_bps: u32,
    pub active_target_bitrate_bps: u32,
    pub encoder_reported_bitrate_bps: Option<u32>,
    pub recent_file_bitrate_bps: Option<u32>,
    pub dropped_frames: u64,
    pub last_rotation_ms: u64,
}

impl IrEncoderStatus {
    pub fn new(width: u32, height: u32, fps: u32, target: u32, reported: Option<u32>) -> Self {
        Self {
            width, height, fps, requested_bitrate_bps: target,
            active_target_bitrate_bps: target, encoder_reported_bitrate_bps: reported,
            recent_file_bitrate_bps: None,
            dropped_frames: 0, last_rotation_ms: 0,
        }
    }

    pub fn request(&mut self, target: u32) {
        self.requested_bitrate_bps = target;
    }

    #[cfg(test)]
    fn pending(&self) -> bool {
        self.requested_bitrate_bps != self.active_target_bitrate_bps
    }
}

/// Resolution/FPS alone never trigger this. The lifecycle lock separately
/// excludes clip exports and capture transitions while this decision is used.
pub fn should_restart_for_bitrate(enabled: bool, segmented: bool, manual: bool, changed: bool) -> bool {
    enabled && segmented && !manual && changed
}

pub fn file_bitrate_bps(bytes: u64, duration_hns: i64) -> Option<u32> {
    if duration_hns <= 0 { return None; }
    Some(((u128::from(bytes) * 80_000_000 / duration_hns as u128).min(u128::from(u32::MAX))) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bitrate_restart_never_interrupts_a_manual_or_non_replay_session() {
        for enabled in [false, true] {
            for segmented in [false, true] {
                for manual in [false, true] {
                    for changed in [false, true] {
                        let allowed = should_restart_for_bitrate(enabled, segmented, manual, changed);
                        assert_eq!(allowed, (enabled, segmented, manual, changed) == (true, true, false, true));
                    }
                }
            }
        }
    }
    #[test]
    fn request_is_not_an_acknowledgement_and_revert_clears_pending() {
        let mut state = IrEncoderStatus::new(1920,1080,60,18_000_000,Some(18_000_000));
        state.request(50_000_000);
        assert!(state.pending());
        assert_eq!(state.encoder_reported_bitrate_bps,Some(18_000_000));
        state.request(18_000_000);
        assert!(!state.pending());
    }
    #[test]
    fn measurement_preserves_sub_millisecond_duration_and_handles_zero() {
        assert_eq!(file_bitrate_bps(12_500_000,20_000_000),Some(50_000_000));
        assert_eq!(file_bitrate_bps(12_500_000,0),None);
        assert!(file_bitrate_bps(12_500_000,20_009_000).unwrap()<50_000_000);
    }
}
