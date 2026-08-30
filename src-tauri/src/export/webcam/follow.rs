use std::path::Path;

use windows::Win32::Media::MediaFoundation::IMFSourceReader;

use super::timeline::{decide_webcam_advance, FollowTimeline, WebcamAdvance};

pub(crate) struct WebcamFollow {
    reader: IMFSourceReader,
    current: Option<(crate::still::StillFrame, i64)>,
    pending: Option<(crate::still::StillFrame, i64)>,
    timeline: FollowTimeline,
    frames: u64,
}

impl WebcamFollow {
    pub(crate) fn open(path: &Path, start_hns: i64, end_hns: i64) -> Result<Self, String> {
        if !path.exists() {
            return Err("Webcam sidecar is no longer on disk.".into());
        }
        let reader = crate::thumb::open_rgb_reader(path)?;
        if start_hns > 0 {
            crate::thumb::seek_hns(&reader, start_hns)?;
        }
        Ok(Self {
            reader,
            current: None,
            pending: None,
            timeline: FollowTimeline::new(start_hns, end_hns),
            frames: 0,
        })
    }

    pub(crate) fn ensure_at(&mut self, gameplay_source: i64) {
        let target = self
            .timeline
            .gameplay_pts(gameplay_source)
            .saturating_add(crate::camera::WEBCAM_FOLLOW_LEAD_HNS);
        let mut last_ts = self.current.as_ref().map(|(_, ts)| *ts);
        loop {
            let Some((frame, ts)) = self.take_webcam_sample() else {
                return;
            };
            let next_norm = self.timeline.webcam_pts(ts);
            match decide_webcam_advance(self.current.is_some(), last_ts, ts, next_norm, target) {
                WebcamAdvance::Adopt => {
                    let non_monotonic = last_ts.is_some_and(|previous| ts <= previous);
                    last_ts = Some(ts);
                    self.current = Some((frame, ts));
                    if non_monotonic {
                        return;
                    }
                }
                WebcamAdvance::KeepCurrent | WebcamAdvance::RejectFuture => {
                    self.pending = Some((frame, ts));
                    return;
                }
            }
        }
    }

    fn take_webcam_sample(&mut self) -> Option<(crate::still::StillFrame, i64)> {
        if let Some(pending) = self.pending.take() {
            return Some(pending);
        }
        match crate::thumb::read_rgb_sample(&self.reader) {
            Ok(Some((frame, ts, _))) => Some((frame, ts)),
            _ => None,
        }
    }

    pub(crate) fn log_sample(&mut self, output_pts: i64, at_end: bool) {
        self.timeline.note_output_pts(output_pts);
        let webcam_source = self.current.as_ref().map(|(_, ts)| *ts);
        let webcam_norm = webcam_source.map(|ts| self.timeline.webcam_pts(ts));
        self.timeline.log_follow(
            self.frames,
            self.timeline.last_gameplay_source(),
            self.timeline.last_gameplay_norm(),
            webcam_source,
            webcam_norm,
            at_end,
        );
        self.frames = self.frames.saturating_add(1);
    }

    pub(crate) fn current_frame(&self) -> Option<&crate::still::StillFrame> {
        self.current.as_ref().map(|(frame, _)| frame)
    }

    pub(crate) fn selected_pts(&self) -> i64 {
        self.current.as_ref().map(|(_, ts)| *ts).unwrap_or(-1)
    }
}
