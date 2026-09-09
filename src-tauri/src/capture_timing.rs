//! Capture cadence and segment placement, always in 100 ns SessionClock units.

pub struct FrameCadence {
    interval_hns: i64,
    next_due_hns: Option<i64>,
}

impl FrameCadence {
    pub fn new(fps: u32) -> Self {
        Self {
            interval_hns: 10_000_000 / i64::from(fps.clamp(24, 60)),
            next_due_hns: None,
        }
    }

    /// Select at most one arrival per output interval without sleeping or
    /// fabricating timestamps. Missed intervals stay missed (no catch-up burst).
    pub fn accept(&mut self, capture_hns: i64) -> bool {
        let now = capture_hns.max(0);
        // A small tolerance avoids halving a nominal 60 Hz source because its
        // callbacks straddle a deadline by a few microseconds.
        let eligible = now.saturating_add(self.interval_hns / 20);
        if let Some(due) = self.next_due_hns {
            if eligible < due {
                return false;
            }
            let intervals = (eligible - due) / self.interval_hns + 1;
            self.next_due_hns =
                Some(due.saturating_add(intervals.saturating_mul(self.interval_hns)));
        } else {
            self.next_due_hns = Some(now.saturating_add(self.interval_hns));
        }
        true
    }
}

pub fn segment_start_hns(end_hns: i64, encoded_duration_hns: i64) -> i64 {
    // Do not round through duration_ms here. Even a sub-ms false overlap can
    // cause a compressed remux to discard the next segment's initial IDR.
    end_hns.max(0).saturating_sub(encoded_duration_hns.max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_refresh_sources_obey_output_cadence() {
        for source_fps in [60, 120, 144, 165, 240] {
            for target in [30, 60] {
                let mut cadence = FrameCadence::new(target);
                let count = (0..source_fps * 10)
                    .filter(|frame| cadence.accept(frame * 10_000_000 / source_fps))
                    .count();
                assert_eq!(count, target as usize * 10, "{source_fps} -> {target}");
            }
        }
    }

    #[test]
    fn stalls_do_not_create_catch_up_bursts_or_rebase_time() {
        let mut cadence = FrameCadence::new(60);
        assert!(cadence.accept(0));
        assert!(cadence.accept(10_000_000));
        assert!(!cadence.accept(10_000_001));
        assert!(!cadence.accept(1));
        assert!(cadence.accept(10_200_000));
    }

    #[test]
    fn fractional_milliseconds_never_drop_the_next_segment_head() {
        let first_end = 21_009_000;
        let first_duration = 20_009_000;
        let second_duration = 20_001_000;
        let origin = segment_start_hns(first_end, first_duration);
        let second_start = segment_start_hns(first_end + second_duration, second_duration);
        assert_eq!(second_start - origin, first_duration);
        // Reproduce the old false overlap: the next initial sample was 0.8 ms early.
        let old_origin = first_end - first_duration / 10_000 * 10_000;
        let old_second_start = first_end + second_duration - second_duration / 10_000 * 10_000;
        assert!(old_second_start - old_origin < first_duration);
    }
}
