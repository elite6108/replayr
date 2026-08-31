use std::path::Path;

use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, IMFSourceReader};

use crate::export::webcam::{decide_webcam_advance, FollowTimeline, WebcamAdvance};

use super::decode::{open_dxgi_reader, read_dxgi_sample, seek_hns, DxgiFrame};

pub(super) struct DxgiWebcam {
    reader: IMFSourceReader,
    pub(super) current: Option<DxgiFrame>,
    pending: Option<DxgiFrame>,
    timeline: FollowTimeline,
    frames: u64,
}

impl DxgiWebcam {
    pub(super) fn open(
        path: &Path,
        manager: &IMFDXGIDeviceManager,
        start_hns: i64,
        end_hns: i64,
    ) -> Result<Self, String> {
        let reader = open_dxgi_reader(path, manager)?;
        if start_hns > 0 {
            seek_hns(&reader, start_hns)?;
        }
        Ok(Self {
            reader,
            current: None,
            pending: None,
            timeline: FollowTimeline::new(start_hns, end_hns),
            frames: 0,
        })
    }

    pub(super) fn ensure_at(&mut self, gameplay_source: i64) {
        let target = self
            .timeline
            .gameplay_pts(gameplay_source)
            .saturating_add(crate::camera::WEBCAM_FOLLOW_LEAD_HNS);
        let mut last_ts = self.current.as_ref().map(|frame| frame.timestamp);
        loop {
            let Some(frame) = self.take_sample() else {
                return;
            };
            let ts = frame.timestamp;
            let next_norm = self.timeline.webcam_pts(ts);
            match decide_webcam_advance(self.current.is_some(), last_ts, ts, next_norm, target) {
                WebcamAdvance::Adopt => {
                    let non_monotonic = last_ts.is_some_and(|previous| ts <= previous);
                    last_ts = Some(ts);
                    self.current = Some(frame);
                    if non_monotonic {
                        return;
                    }
                }
                WebcamAdvance::KeepCurrent | WebcamAdvance::RejectFuture => {
                    self.pending = Some(frame);
                    return;
                }
            }
        }
    }

    fn take_sample(&mut self) -> Option<DxgiFrame> {
        if let Some(pending) = self.pending.take() {
            return Some(pending);
        }
        read_dxgi_sample(&self.reader).ok().flatten()
    }

    pub(super) fn log_sample(&mut self, output_pts: i64, at_end: bool) {
        self.timeline.note_output_pts(output_pts);
        let webcam_source = self.current.as_ref().map(|frame| frame.timestamp);
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
}