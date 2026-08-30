//! Session-clock placement for Instant Replay / webcam concat.
//!
//! Output PTS is derived from each segment's session start, never from the
//! previous file's Media Foundation duration. Gaps stay gaps.

/// How compose should interpret source PTS on a remuxed stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineBasis {
    /// Legacy files: first decoded sample is treated as t=0.
    FileRelative,
    /// Session-placed concat/trim: PTS 0 is clip `window.start_hns`.
    ClipSessionRelative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionSegment {
    pub start_hns: i64,
    pub end_hns: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinPlan {
    pub segment_index: usize,
    pub segment_start_hns: i64,
    pub segment_end_hns: i64,
    pub session_offset_hns: i64,
    pub expected_output_first_pts: i64,
    pub gap_from_previous_hns: i64,
    pub overlap_hns: i64,
}

pub fn session_offset(segment_start_hns: i64, origin_hns: i64) -> i64 {
    segment_start_hns.saturating_sub(origin_hns)
}

pub fn output_pts(segment_start_hns: i64, origin_hns: i64, source_pts: i64) -> i64 {
    session_offset(segment_start_hns, origin_hns).saturating_add(source_pts.max(0))
}

/// Clip t=0 is `window_start_hns`. Do not rebase to the first retained sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipSampleKeep {
    Keep,
    DropBefore,
    DropAfter,
}

pub fn clip_sample_keep(output_pts: i64, window_duration_hns: i64) -> ClipSampleKeep {
    if output_pts < 0 {
        ClipSampleKeep::DropBefore
    } else if output_pts >= window_duration_hns {
        ClipSampleKeep::DropAfter
    } else {
        ClipSampleKeep::Keep
    }
}

pub fn placement_error_hns(output_first_pts: i64, expected_output_first_pts: i64) -> i64 {
    output_first_pts.saturating_sub(expected_output_first_pts)
}

pub fn plan_joins(segments: &[SessionSegment], origin_hns: i64) -> Vec<JoinPlan> {
    let mut plans = Vec::with_capacity(segments.len());
    let mut previous_end: Option<i64> = None;
    for (segment_index, segment) in segments.iter().enumerate() {
        let session_offset_hns = session_offset(segment.start_hns, origin_hns);
        let (gap_from_previous_hns, overlap_hns) = match previous_end {
            Some(previous) if segment.start_hns > previous => (segment.start_hns - previous, 0),
            Some(previous) if segment.start_hns < previous => (0, previous - segment.start_hns),
            _ => (0, 0),
        };
        plans.push(JoinPlan {
            segment_index,
            segment_start_hns: segment.start_hns,
            segment_end_hns: segment.end_hns,
            session_offset_hns,
            expected_output_first_pts: session_offset_hns,
            gap_from_previous_hns,
            overlap_hns,
        });
        previous_end = Some(segment.end_hns.max(segment.start_hns));
    }
    plans
}

/// Hold the previous video frame through a positive session gap.
pub fn hold_hns(written_end_pts: i64, next_output_start_pts: i64) -> i64 {
    next_output_start_pts.saturating_sub(written_end_pts).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_S: i64 = 20_000_000;
    const HUNDRED_MS: i64 = 1_000_000;

    #[test]
    fn webcam_preserved_hole_places_b_at_ten_seconds() {
        let plans = plan_joins(
            &[
                SessionSegment {
                    start_hns: 100_000_000,
                    end_hns: 120_000_000,
                },
                SessionSegment {
                    start_hns: 200_000_000,
                    end_hns: 220_000_000,
                },
            ],
            100_000_000,
        );
        assert_eq!(plans[0].expected_output_first_pts, 0);
        assert_eq!(output_pts(100_000_000, 100_000_000, 0), 0);
        assert_eq!(output_pts(100_000_000, 100_000_000, 20_000_000), 20_000_000);
        assert_eq!(plans[1].session_offset_hns, 100_000_000);
        assert_eq!(plans[1].expected_output_first_pts, 100_000_000);
        assert_eq!(output_pts(200_000_000, 100_000_000, 0), 100_000_000);
        assert_ne!(plans[1].expected_output_first_pts, 20_000_000);
        assert_eq!(plans[1].gap_from_previous_hns, 80_000_000);
    }

    #[test]
    fn gameplay_preserved_gap_keeps_hundred_ms_hole() {
        let plans = plan_joins(
            &[
                SessionSegment {
                    start_hns: 0,
                    end_hns: TWO_S,
                },
                SessionSegment {
                    start_hns: TWO_S + HUNDRED_MS,
                    end_hns: TWO_S + HUNDRED_MS + TWO_S,
                },
            ],
            0,
        );
        assert_eq!(plans[1].session_offset_hns, TWO_S + HUNDRED_MS);
        assert_eq!(plans[1].gap_from_previous_hns, HUNDRED_MS);
        assert_eq!(hold_hns(TWO_S, plans[1].expected_output_first_pts), HUNDRED_MS);
    }

    #[test]
    fn one_hundred_fifty_segments_do_not_accumulate_file_duration_error() {
        let segments: Vec<SessionSegment> = (0..150)
            .map(|index| {
                let start = i64::from(index) * TWO_S;
                SessionSegment {
                    start_hns: start,
                    end_hns: start + TWO_S - 500_000,
                }
            })
            .collect();
        let plans = plan_joins(&segments, 0);
        let last = plans.last().expect("150 segments");
        assert_eq!(last.session_offset_hns, 149 * TWO_S);
        assert_eq!(last.expected_output_first_pts, 149 * TWO_S);
        assert_eq!(placement_error_hns(last.expected_output_first_pts, 149 * TWO_S), 0);
        let stacked = 149 * (TWO_S - 500_000);
        assert_ne!(last.expected_output_first_pts, stacked);
    }

    #[test]
    fn late_webcam_segment_keeps_leading_gap() {
        let window_start = 200_000_000;
        let segment_start = 204_000_000;
        let out = output_pts(segment_start, window_start, 0);
        assert_eq!(out, 4_000_000);
        assert_eq!(clip_sample_keep(out, 60_000_000), ClipSampleKeep::Keep);
        assert_ne!(out, 0);
    }

    #[test]
    fn mid_file_window_drops_pre_window_samples() {
        let window_start = 220_000_000;
        let window_duration = 40_000_000;
        let segment_start = 200_000_000;
        let drop = output_pts(segment_start, window_start, 0);
        let first = output_pts(segment_start, window_start, 20_000_000);
        let next = output_pts(segment_start, window_start, 20_330_000);
        assert_eq!(drop, -20_000_000);
        assert_eq!(clip_sample_keep(drop, window_duration), ClipSampleKeep::DropBefore);
        assert_eq!(first, 0);
        assert_eq!(clip_sample_keep(first, window_duration), ClipSampleKeep::Keep);
        assert_eq!(next, 330_000);
        assert_eq!(clip_sample_keep(next, window_duration), ClipSampleKeep::Keep);
    }

    #[test]
    fn camera_starts_after_window_retains_leading_hole() {
        let window_start = 0;
        let window_duration = 60_000_000;
        let camera_start = 20_000_000;
        let out = output_pts(camera_start, window_start, 0);
        assert_eq!(out, 20_000_000);
        assert_eq!(clip_sample_keep(out, window_duration), ClipSampleKeep::Keep);
        assert_ne!(out, 0);
    }

    #[test]
    fn overlap_is_explicit_and_does_not_extend_timeline() {
        let plans = plan_joins(
            &[
                SessionSegment {
                    start_hns: 0,
                    end_hns: TWO_S + HUNDRED_MS,
                },
                SessionSegment {
                    start_hns: TWO_S,
                    end_hns: TWO_S * 2,
                },
            ],
            0,
        );
        assert_eq!(plans[1].overlap_hns, HUNDRED_MS);
        assert_eq!(plans[1].gap_from_previous_hns, 0);
        assert_eq!(plans[1].expected_output_first_pts, TWO_S);
    }
}
