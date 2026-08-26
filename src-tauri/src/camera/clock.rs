//! Map camera IMFSample timestamps onto Replayr's session timeline.
//!
//! Gameplay and webcam do **not** share frame counts or segment indexes. Both
//! sit on the same absolute session HNS clock. Camera samples keep their
//! source timestamps; we store one origin offset at the first usable sample
//! and map through it. Arrival QPC is for diagnostics, discontinuity
//! detection, and fallback when the driver timestamps are unusable.

use std::time::{Duration, Instant};

pub const SEGMENT_HNS: i64 = 20_000_000;
pub const HNS_PER_SECOND: i64 = 10_000_000;

/// Jump larger than this versus the previous mapped time is a discontinuity.
const DISCONTINUITY_HNS: i64 = 5_000_000; // 500 ms
const MIN_DURATION_HNS: i64 = 10_000; // 100 µs
const MAX_DURATION_HNS: i64 = HNS_PER_SECOND; // 1 s
const SKEW_WARN_HNS: i64 = 500_000; // 50 ms
const SKEW_LOG_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentHealth {
    Valid,
    Failed,
    Gap,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSegment {
    pub start_hns: i64,
    pub end_hns: i64,
    pub path: String,
    pub health: SegmentHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappedSample {
    pub session_hns: i64,
    pub duration_hns: i64,
    pub used_source_timestamp: bool,
    pub fallback: bool,
}

/// Shared T0 for gameplay Instant-elapsed HNS, audio QPC origin, and webcam mapping.
#[derive(Debug, Clone, Copy)]
pub struct SessionClock {
    instant: Instant,
    qpc_origin_hns: i64,
}

impl SessionClock {
    /// Pair Instant and QPC in that order, matching gameplay capture start.
    pub fn start() -> Self {
        let instant = Instant::now();
        Self {
            instant,
            qpc_origin_hns: current_qpc_hns(),
        }
    }

    pub fn qpc_origin_hns(&self) -> i64 {
        self.qpc_origin_hns
    }

    /// Gameplay capture timestamp: nanoseconds since T0, in 100 ns units.
    pub fn capture_hns(&self) -> i64 {
        (self.instant.elapsed().as_nanos() / 100) as i64
    }

    /// Arrival QPC expressed as session elapsed HNS.
    pub fn arrival_hns(&self, arrival_qpc: i64) -> i64 {
        arrival_qpc.saturating_sub(self.qpc_origin_hns).max(0)
    }
}

fn current_qpc_hns() -> i64 {
    #[cfg(windows)]
    {
        crate::audio_timeline::qpc_hns()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[derive(Debug, Clone)]
pub struct CameraClockMap {
    session_origin_hns: i64,
    camera_origin_hns: Option<i64>,
    session_at_origin_hns: Option<i64>,
    last_camera_hns: Option<i64>,
    last_mapped_hns: Option<i64>,
    last_skew_hns: Option<i64>,
    last_skew_log: Option<Instant>,
    fallback_to_arrival: bool,
    nominal_duration_hns: i64,
}

impl CameraClockMap {
    /// `session_origin_hns` is QPC at session T0, not a session-elapsed stamp.
    pub fn new(session_origin_hns: i64, fps: u32) -> Self {
        Self {
            session_origin_hns,
            camera_origin_hns: None,
            session_at_origin_hns: None,
            last_camera_hns: None,
            last_mapped_hns: None,
            last_skew_hns: None,
            last_skew_log: None,
            fallback_to_arrival: false,
            nominal_duration_hns: nominal_frame_duration(fps),
        }
    }

    pub fn is_fallback(&self) -> bool {
        self.fallback_to_arrival
    }

    pub fn last_skew_hns(&self) -> Option<i64> {
        self.last_skew_hns
    }

    /// Map one camera sample onto the session timeline.
    ///
    /// `sample_time_hns` / `sample_duration_hns` come from the IMFSample.
    /// `arrival_qpc_hns` is Replayr QPC at ReadSample return.
    pub fn map_sample(
        &mut self,
        sample_time_hns: Option<i64>,
        sample_duration_hns: Option<i64>,
        arrival_qpc_hns: i64,
    ) -> MappedSample {
        let duration = clamp_duration(sample_duration_hns, self.nominal_duration_hns);
        if self.fallback_to_arrival {
            return self.map_arrival(arrival_qpc_hns, duration);
        }
        match sample_time_hns {
            Some(camera_hns) if is_usable_timestamp(camera_hns, self.last_camera_hns) => {
                let arrival_session = self.arrival_session(arrival_qpc_hns);
                if self.camera_origin_hns.is_none() {
                    self.camera_origin_hns = Some(camera_hns);
                    self.session_at_origin_hns = Some(arrival_session);
                }
                let origin = self.camera_origin_hns.unwrap_or(camera_hns);
                let session_at_origin = self.session_at_origin_hns.unwrap_or(arrival_session);
                let mapped = session_at_origin.saturating_add(camera_hns.saturating_sub(origin));
                if self.is_discontinuity(mapped) {
                    tracing::warn!(
                        camera_hns,
                        mapped,
                        last = self.last_mapped_hns,
                        "camera timestamp discontinuity; re-anchoring from arrival QPC"
                    );
                    self.reanchor_from_arrival(camera_hns, arrival_qpc_hns);
                    return self.map_arrival(arrival_qpc_hns, duration);
                }
                self.last_camera_hns = Some(camera_hns);
                self.last_mapped_hns = Some(mapped);
                self.note_skew(arrival_session, mapped);
                MappedSample {
                    session_hns: mapped,
                    duration_hns: duration,
                    used_source_timestamp: true,
                    fallback: false,
                }
            }
            other => {
                if !self.fallback_to_arrival {
                    tracing::warn!(
                        sample_time = ?other,
                        last = self.last_camera_hns,
                        "camera timestamps unusable; falling back to SessionClock arrival"
                    );
                    self.fallback_to_arrival = true;
                }
                self.map_arrival(arrival_qpc_hns, duration)
            }
        }
    }

    fn arrival_session(&self, arrival_qpc_hns: i64) -> i64 {
        arrival_qpc_hns.saturating_sub(self.session_origin_hns).max(0)
    }

    fn map_arrival(&mut self, arrival_qpc_hns: i64, duration: i64) -> MappedSample {
        let mapped = self.arrival_session(arrival_qpc_hns);
        self.last_mapped_hns = Some(mapped);
        self.note_skew(mapped, mapped);
        MappedSample {
            session_hns: mapped,
            duration_hns: duration,
            used_source_timestamp: false,
            fallback: true,
        }
    }

    fn reanchor_from_arrival(&mut self, camera_hns: i64, arrival_qpc_hns: i64) {
        let session_now = self.arrival_session(arrival_qpc_hns);
        self.camera_origin_hns = Some(camera_hns);
        self.session_at_origin_hns = Some(session_now);
        self.last_camera_hns = Some(camera_hns);
        self.last_mapped_hns = Some(session_now);
    }

    fn is_discontinuity(&self, mapped: i64) -> bool {
        match self.last_mapped_hns {
            Some(previous) if mapped + MIN_DURATION_HNS < previous => true,
            Some(previous) if mapped.saturating_sub(previous) > DISCONTINUITY_HNS => true,
            _ => false,
        }
    }

    fn note_skew(&mut self, arrival_session: i64, mapped: i64) {
        let skew = if mapped > arrival_session {
            mapped.saturating_sub(arrival_session).saturating_neg()
        } else {
            arrival_session.saturating_sub(mapped)
        };
        self.last_skew_hns = Some(skew);
        if skew.unsigned_abs() < SKEW_WARN_HNS as u64 {
            return;
        }
        let now = Instant::now();
        if self
            .last_skew_log
            .is_some_and(|previous| now.saturating_duration_since(previous) < SKEW_LOG_INTERVAL)
        {
            return;
        }
        self.last_skew_log = Some(now);
        tracing::warn!(
            skew_ms = skew / 10_000,
            mapped,
            arrival_session,
            "webcam vs SessionClock skew"
        );
    }
}

pub fn nominal_frame_duration(fps: u32) -> i64 {
    HNS_PER_SECOND / i64::from(fps.max(1))
}

pub fn segment_index(session_hns: i64) -> i64 {
    session_hns.max(0) / SEGMENT_HNS
}

pub fn segment_bounds(index: i64) -> (i64, i64) {
    let start = index.max(0).saturating_mul(SEGMENT_HNS);
    (start, start.saturating_add(SEGMENT_HNS))
}

/// Select every segment that overlaps `[range_start, range_end)`.
/// Missing / failed segments stay in the result so callers can treat them as gaps.
pub fn overlapping_segments(segments: &[SourceSegment], range_start: i64, range_end: i64) -> Vec<&SourceSegment> {
    if range_end <= range_start {
        return Vec::new();
    }
    segments
        .iter()
        .filter(|segment| segment.start_hns < range_end && segment.end_hns > range_start)
        .collect()
}

fn is_usable_timestamp(camera_hns: i64, last: Option<i64>) -> bool {
    if camera_hns < 0 {
        return false;
    }
    match last {
        Some(previous) if camera_hns < previous => false,
        _ => true,
    }
}

fn clamp_duration(sample_duration_hns: Option<i64>, nominal: i64) -> i64 {
    match sample_duration_hns {
        Some(duration) if duration >= MIN_DURATION_HNS && duration <= MAX_DURATION_HNS => duration,
        _ => nominal.max(MIN_DURATION_HNS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_source_timestamps_through_origin_offset() {
        let mut clock = CameraClockMap::new(1_000_000, 30);
        let first = clock.map_sample(Some(50_000_000), Some(333_333), 1_000_000);
        let second = clock.map_sample(Some(50_333_333), Some(333_333), 1_040_000);
        assert_eq!(first.session_hns, 0);
        assert!(first.used_source_timestamp);
        assert_eq!(second.session_hns, 333_333);
        assert!(!clock.is_fallback());
    }

    #[test]
    fn late_first_sample_sits_at_arrival_elapsed() {
        let mut clock = CameraClockMap::new(10_000_000, 30);
        let first = clock.map_sample(Some(1_000), Some(333_333), 12_000_000);
        let second = clock.map_sample(Some(1_000 + 333_333), Some(333_333), 12_333_333);
        assert_eq!(first.session_hns, 2_000_000);
        assert!(first.used_source_timestamp);
        assert_eq!(second.session_hns, 2_333_333);
        assert!(!clock.is_fallback());
    }

    #[test]
    fn preserves_valid_source_duration() {
        let mut clock = CameraClockMap::new(0, 30);
        let mapped = clock.map_sample(Some(0), Some(400_000), 0);
        assert_eq!(mapped.duration_hns, 400_000);
    }

    #[test]
    fn falls_back_on_non_monotonic_timestamps() {
        let mut clock = CameraClockMap::new(10_000, 30);
        let _ = clock.map_sample(Some(1000), Some(333_333), 10_000);
        let mapped = clock.map_sample(Some(10), Some(333_333), 20_000);
        assert!(mapped.fallback);
        assert!(!mapped.used_source_timestamp);
        assert!(clock.is_fallback());
        assert_eq!(mapped.session_hns, 10_000);
    }

    #[test]
    fn falls_back_on_missing_timestamps() {
        let mut clock = CameraClockMap::new(5_000, 30);
        let mapped = clock.map_sample(None, None, 15_000);
        assert!(mapped.fallback);
        assert_eq!(mapped.session_hns, 10_000);
        assert_eq!(mapped.duration_hns, nominal_frame_duration(30));
    }

    #[test]
    fn session_clock_arrival_is_elapsed_from_qpc_origin() {
        let clock = SessionClock {
            instant: Instant::now(),
            qpc_origin_hns: 10_000_000,
        };
        assert_eq!(clock.arrival_hns(12_000_000), 2_000_000);
        assert_eq!(clock.arrival_hns(5_000_000), 0);
        assert!(clock.capture_hns() >= 0);
    }

    #[test]
    fn source_mapping_skew_is_arrival_minus_mapped() {
        let mut clock = CameraClockMap::new(0, 30);
        let _ = clock.map_sample(Some(0), Some(333_333), 0);
        let _ = clock.map_sample(Some(333_333), Some(333_333), 400_000);
        assert_eq!(clock.last_skew_hns(), Some(66_667));
    }

    #[test]
    fn segment_index_uses_absolute_session_grid() {
        assert_eq!(segment_index(0), 0);
        assert_eq!(segment_index(SEGMENT_HNS - 1), 0);
        assert_eq!(segment_index(SEGMENT_HNS), 1);
        assert_eq!(segment_index(SEGMENT_HNS * 5 + 3), 5);
        assert_eq!(segment_bounds(2), (40_000_000, 60_000_000));
    }

    #[test]
    fn overlapping_webcam_segments_follow_gameplay_interval() {
        let segments = [
            SourceSegment {
                start_hns: 0,
                end_hns: 20_000_000,
                path: "cam-0.mp4".into(),
                health: SegmentHealth::Valid,
            },
            SourceSegment {
                start_hns: 20_000_000,
                end_hns: 40_000_000,
                path: "cam-1.mp4".into(),
                health: SegmentHealth::Gap,
            },
            SourceSegment {
                start_hns: 40_000_000,
                end_hns: 60_000_000,
                path: "cam-2.mp4".into(),
                health: SegmentHealth::Failed,
            },
        ];
        let chosen = overlapping_segments(&segments, 18_000_000, 42_000_000);
        assert_eq!(chosen.len(), 3);
        assert_eq!(chosen[1].health, SegmentHealth::Gap);
        assert_eq!(chosen[2].health, SegmentHealth::Failed);
        assert!(overlapping_segments(&segments, 60_000_000, 80_000_000).is_empty());
    }
}
