//! Webcam follow clock.
//!
//! Session-placed remuxes use [`TimelineBasis::ClipSessionRelative`]: PTS 0 is
//! clip start. Compare gameplay and webcam PTS directly.
//!
//! Legacy files use [`TimelineBasis::FileRelative`]: each stream is re-anchored
//! to its first decoded sample.

use super::super::session_place::TimelineBasis;

const ONE_S_HNS: i64 = 10_000_000;
const FIVE_S_HNS: i64 = 50_000_000;
const TEN_S_HNS: i64 = 100_000_000;
const THIRTY_S_HNS: i64 = 300_000_000;
const ONE_FIFTY_S_HNS: i64 = 1_500_000_000;
const THREE_HUNDRED_S_HNS: i64 = 3_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebcamAdvance {
    /// `next` is still on or before the gameplay clock; replace current and keep reading.
    Adopt,
    /// `next` is already past gameplay; keep the previous webcam frame.
    KeepCurrent,
    /// No previous frame, and `next` is already past gameplay. Show nothing yet.
    RejectFuture,
}

#[derive(Debug)]
pub(crate) struct FollowTimeline {
    basis: TimelineBasis,
    clip_start_hns: i64,
    clip_end_hns: i64,
    gameplay_anchor: Option<i64>,
    webcam_anchor: Option<i64>,
    first_gameplay_source: Option<i64>,
    first_webcam_source: Option<i64>,
    first_output_pts: Option<i64>,
    last_gameplay_source: i64,
    last_gameplay_norm: i64,
    logged_header: bool,
    logged_1s: bool,
    logged_5s: bool,
    logged_10s: bool,
    logged_30s: bool,
    logged_150s: bool,
    logged_300s: bool,
}

impl FollowTimeline {
    pub(crate) fn new(clip_start_hns: i64, clip_end_hns: i64) -> Self {
        Self::with_basis(clip_start_hns, clip_end_hns, TimelineBasis::ClipSessionRelative)
    }

    pub(crate) fn with_basis(clip_start_hns: i64, clip_end_hns: i64, basis: TimelineBasis) -> Self {
        Self {
            basis,
            clip_start_hns,
            clip_end_hns,
            gameplay_anchor: None,
            webcam_anchor: None,
            first_gameplay_source: None,
            first_webcam_source: None,
            first_output_pts: None,
            last_gameplay_source: 0,
            last_gameplay_norm: 0,
            logged_header: false,
            logged_1s: false,
            logged_5s: false,
            logged_10s: false,
            logged_30s: false,
            logged_150s: false,
            logged_300s: false,
        }
    }

    pub(crate) fn basis(&self) -> TimelineBasis {
        self.basis
    }

    fn normalize(&self, source_pts: i64, anchor: i64) -> i64 {
        match self.basis {
            TimelineBasis::ClipSessionRelative => source_pts,
            TimelineBasis::FileRelative => source_pts.saturating_sub(anchor),
        }
    }

    pub(crate) fn gameplay_pts(&mut self, source_pts: i64) -> i64 {
        let anchor = *self.gameplay_anchor.get_or_insert(source_pts);
        if self.first_gameplay_source.is_none() {
            self.first_gameplay_source = Some(source_pts);
        }
        let norm = self.normalize(source_pts, anchor);
        self.last_gameplay_source = source_pts;
        self.last_gameplay_norm = norm;
        norm
    }

    pub(crate) fn last_gameplay_source(&self) -> i64 {
        self.last_gameplay_source
    }

    pub(crate) fn last_gameplay_norm(&self) -> i64 {
        self.last_gameplay_norm
    }

    pub(crate) fn webcam_pts(&mut self, source_pts: i64) -> i64 {
        let anchor = *self.webcam_anchor.get_or_insert(source_pts);
        if self.first_webcam_source.is_none() {
            self.first_webcam_source = Some(source_pts);
        }
        self.normalize(source_pts, anchor)
    }

    pub(crate) fn note_output_pts(&mut self, output_pts: i64) {
        if self.first_output_pts.is_none() {
            self.first_output_pts = Some(output_pts);
        }
    }

    pub(crate) fn log_origins_once(&mut self) {
        if self.logged_header {
            return;
        }
        self.logged_header = true;
        let gp_src = self.first_gameplay_source.unwrap_or(-1);
        let cam_src = self.first_webcam_source.unwrap_or(-1);
        tracing::info!(
            capture_session_t0 = "unavailable_at_compose",
            timeline_basis = ?self.basis,
            clip_start_hns = self.clip_start_hns,
            clip_end_hns = self.clip_end_hns,
            gameplay_first_source_pts = gp_src,
            gameplay_first_normalized_pts = if self.basis == TimelineBasis::ClipSessionRelative {
                gp_src
            } else {
                0
            },
            gameplay_first_output_pts = self.first_output_pts.unwrap_or(0),
            webcam_first_source_pts = cam_src,
            webcam_first_normalized_pts = if self.basis == TimelineBasis::ClipSessionRelative {
                cam_src
            } else {
                0
            },
            webcam_first_output_pts = cam_src,
            raw_origin_delta_hns = if gp_src >= 0 && cam_src >= 0 {
                cam_src - gp_src
            } else {
                0
            },
            "webcam follow timeline origins"
        );
    }

    pub(crate) fn log_follow(
        &mut self,
        frame_index: u64,
        gameplay_source: i64,
        gameplay_norm: i64,
        webcam_source: Option<i64>,
        webcam_norm: Option<i64>,
        at_end: bool,
    ) {
        self.log_origins_once();
        let at_1s = !self.logged_1s && gameplay_norm >= ONE_S_HNS;
        let at_5s = !self.logged_5s && gameplay_norm >= FIVE_S_HNS;
        let at_10s = !self.logged_10s && gameplay_norm >= TEN_S_HNS;
        let at_30s = !self.logged_30s && gameplay_norm >= THIRTY_S_HNS;
        let at_150s = !self.logged_150s && gameplay_norm >= ONE_FIFTY_S_HNS;
        let at_300s = !self.logged_300s && gameplay_norm >= THREE_HUNDRED_S_HNS;
        if at_1s {
            self.logged_1s = true;
        }
        if at_5s {
            self.logged_5s = true;
        }
        if at_10s {
            self.logged_10s = true;
        }
        if at_30s {
            self.logged_30s = true;
        }
        if at_150s {
            self.logged_150s = true;
        }
        if at_300s {
            self.logged_300s = true;
        }
        if frame_index >= 10 && !at_1s && !at_5s && !at_10s && !at_30s && !at_150s && !at_300s && !at_end {
            return;
        }
        let mark = if frame_index < 10 {
            "0s"
        } else if at_end {
            "end"
        } else if at_300s {
            "300s"
        } else if at_150s {
            "150s"
        } else if at_30s {
            "30s"
        } else if at_10s {
            "10s"
        } else if at_1s {
            "1s"
        } else {
            "5s"
        };
        let webcam_pts = webcam_source.unwrap_or(-1);
        let webcam_n = webcam_norm.unwrap_or(-1);
        tracing::info!(
            mark,
            frame_index,
            timeline_basis = ?self.basis,
            gameplay_source_pts = gameplay_source,
            gameplay_pts = gameplay_norm,
            selected_webcam_source_pts = webcam_pts,
            selected_webcam_pts = webcam_n,
            delta_hns = if webcam_n >= 0 {
                webcam_n - gameplay_norm
            } else {
                0
            },
            raw_delta_hns = if webcam_pts >= 0 {
                webcam_pts - gameplay_source
            } else {
                0
            },
            "webcam follow sample"
        );
    }
}

/// Decide whether the just-read webcam sample belongs under `target_norm`.
pub(crate) fn decide_webcam_advance(
    has_current: bool,
    last_source: Option<i64>,
    next_source: i64,
    next_norm: i64,
    target_norm: i64,
) -> WebcamAdvance {
    if last_source.is_some_and(|previous| next_source <= previous) {
        return WebcamAdvance::Adopt;
    }
    if next_norm <= target_norm {
        WebcamAdvance::Adopt
    } else if has_current {
        WebcamAdvance::KeepCurrent
    } else {
        WebcamAdvance::RejectFuture
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_relative_normalizes_each_stream_to_its_first_sample() {
        let mut clock = FollowTimeline::with_basis(0, 100_000_000, TimelineBasis::FileRelative);
        assert_eq!(clock.gameplay_pts(15_000_000), 0);
        assert_eq!(clock.gameplay_pts(16_666_667), 1_666_667);
        assert_eq!(clock.webcam_pts(0), 0);
        assert_eq!(clock.webcam_pts(1_666_667), 1_666_667);
    }

    #[test]
    fn clip_session_relative_does_not_subtract_first_sample_origins() {
        let mut clock = FollowTimeline::new(0, 3_000_000_000);
        assert_eq!(clock.basis(), TimelineBasis::ClipSessionRelative);
        assert_eq!(clock.gameplay_pts(15_000_000), 15_000_000);
        assert_eq!(clock.gameplay_pts(16_666_667), 16_666_667);
        assert_eq!(clock.webcam_pts(14_800_000), 14_800_000);
        assert_eq!(clock.webcam_pts(16_666_667), 16_666_667);
        assert_eq!(
            decide_webcam_advance(true, Some(14_800_000), 16_666_667, 16_666_667, 15_000_000),
            WebcamAdvance::KeepCurrent
        );
        assert_eq!(
            decide_webcam_advance(true, Some(14_800_000), 15_000_000, 15_000_000, 16_666_667),
            WebcamAdvance::Adopt
        );
    }

    #[test]
    fn adopts_latest_webcam_not_past_gameplay() {
        assert_eq!(
            decide_webcam_advance(false, None, 0, 0, 0),
            WebcamAdvance::Adopt
        );
        assert_eq!(
            decide_webcam_advance(true, Some(0), 400_000, 400_000, 166_667),
            WebcamAdvance::KeepCurrent
        );
        assert_eq!(
            decide_webcam_advance(true, Some(0), 166_667, 166_667, 400_000),
            WebcamAdvance::Adopt
        );
        assert_eq!(
            decide_webcam_advance(false, None, 15_000_000, 15_000_000, 0),
            WebcamAdvance::RejectFuture
        );
    }

    #[test]
    fn stops_on_non_monotonic_source_pts() {
        assert_eq!(
            decide_webcam_advance(true, Some(1_000_000), 999_000, 999_000, 2_000_000),
            WebcamAdvance::Adopt
        );
    }
}
