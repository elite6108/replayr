use std::path::Path;

use windows::Win32::Media::MediaFoundation::IMFSourceReader;

pub(crate) struct WebcamFollow {
    reader: IMFSourceReader,
    current: Option<(crate::still::StillFrame, i64)>,
}

impl WebcamFollow {
    pub(crate) fn open(path: &Path, start_hns: i64) -> Result<Self, String> {
        if !path.exists() {
            return Err("Webcam sidecar is no longer on disk.".into());
        }
        let reader = crate::thumb::open_rgb_reader(path)?;
        let seek = start_hns
            .saturating_sub(crate::camera::WEBCAM_SYNC_DELAY_HNS)
            .max(0);
        if seek > 0 {
            crate::thumb::seek_hns(&reader, seek)?;
        }
        Ok(Self {
            reader,
            current: None,
        })
    }

    pub(crate) fn ensure_at(&mut self, target_hns: i64) {
        // Sample an earlier webcam frame so the overlay matches gameplay/audio.
        let target_hns = target_hns
            .saturating_sub(crate::camera::WEBCAM_SYNC_DELAY_HNS)
            .max(0);
        let mut last_ts = self.current.as_ref().map(|(_, ts)| *ts);
        loop {
            if let Some((_, ts)) = &self.current {
                if *ts + 10_000 >= target_hns {
                    return;
                }
            }
            match crate::thumb::read_rgb_sample(&self.reader) {
                Ok(Some((frame, ts, _))) => {
                    // Non-advancing PTS would spin forever before the first encode write.
                    if last_ts.is_some_and(|previous| ts <= previous) {
                        self.current = Some((frame, ts));
                        return;
                    }
                    last_ts = Some(ts);
                    let caught_up = ts >= target_hns;
                    self.current = Some((frame, ts));
                    if caught_up {
                        return;
                    }
                }
                _ => return,
            }
        }
    }

    pub(crate) fn current_frame(&self) -> Option<&crate::still::StillFrame> {
        self.current.as_ref().map(|(frame, _)| frame)
    }
}
