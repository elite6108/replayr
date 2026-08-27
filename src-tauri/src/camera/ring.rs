//! Rolling webcam segment ring on the shared SessionClock grid.
//!
//! Gameplay and webcam keep separate files. This ring only tracks webcam
//! health so F10 can pick overlapping segments without touching WGC.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::clock::{
    overlapping_segments, remux_paths, segment_bounds, segment_index, SegmentHealth, SourceSegment,
    SEGMENT_HNS, WEBCAM_FILE_HNS,
};

pub const WEBCAM_ROTATE_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Debug)]
struct StoredSegment {
    segment: SourceSegment,
    locked: bool,
}

#[derive(Debug)]
pub struct WebcamBuffer {
    segments: Vec<StoredSegment>,
    max_keep_hns: i64,
}

impl WebcamBuffer {
    pub fn new(max_keep_ms: u64) -> Self {
        Self {
            segments: Vec::new(),
            max_keep_hns: keep_hns(max_keep_ms),
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn set_max_keep_ms(&mut self, max_keep_ms: u64) {
        self.max_keep_hns = keep_hns(max_keep_ms);
    }

    pub fn push(&mut self, segment: SourceSegment) {
        self.segments.push(StoredSegment {
            segment,
            locked: false,
        });
        self.prune(true);
    }

    pub fn push_gap(&mut self, index: i64) {
        let (start_hns, end_hns) = segment_bounds(index);
        self.push(SourceSegment {
            start_hns,
            end_hns,
            path: String::new(),
            health: SegmentHealth::Gap,
        });
    }

    pub fn fill_gaps_before(&mut self, next_index: i64) {
        let last = self
            .segments
            .last()
            .map(|stored| segment_index(stored.segment.start_hns));
        let Some(last) = last else {
            return;
        };
        let mut index = last.saturating_add(1);
        while index < next_index {
            self.push_gap(index);
            index += 1;
        }
    }

    pub fn fill_webcam_file_gaps_before(&mut self, next_file_index: i64) {
        use super::clock::{webcam_file_bounds, webcam_file_index};
        let last = self
            .segments
            .last()
            .map(|stored| webcam_file_index(stored.segment.start_hns));
        let Some(last) = last else {
            return;
        };
        let mut index = last.saturating_add(1);
        while index < next_file_index {
            let (start_hns, end_hns) = webcam_file_bounds(index);
            self.push(SourceSegment {
                start_hns,
                end_hns,
                path: String::new(),
                health: SegmentHealth::Gap,
            });
            index += 1;
        }
    }

    pub fn snapshot(&self) -> Vec<SourceSegment> {
        self.segments.iter().map(|stored| stored.segment.clone()).collect()
    }

    pub fn remux_paths(&self, range_start: i64, range_end: i64) -> Vec<PathBuf> {
        remux_paths(&self.snapshot(), range_start, range_end)
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }

    pub fn lock_range(&mut self, range_start: i64, range_end: i64) {
        for stored in &mut self.segments {
            if stored.segment.start_hns < range_end && stored.segment.end_hns > range_start {
                stored.locked = true;
            }
        }
    }

    pub fn unlock_all(&mut self) {
        for stored in &mut self.segments {
            stored.locked = false;
        }
        self.prune(true);
    }

    pub fn clear(&mut self, delete_files: bool) {
        while let Some(stored) = self.segments.pop() {
            if delete_files {
                remove_webcam_file(&stored.segment.path);
            }
        }
    }

    pub fn prune(&mut self, delete_files: bool) {
        let latest_end = self
            .segments
            .iter()
            .map(|stored| stored.segment.end_hns)
            .max()
            .unwrap_or(0);
        let cutoff = latest_end.saturating_sub(self.max_keep_hns);
        while let Some(front) = self.segments.first() {
            if front.locked || front.segment.end_hns > cutoff {
                break;
            }
            let dropped = self.segments.remove(0);
            if delete_files {
                remove_webcam_file(&dropped.segment.path);
            }
        }
    }

    pub fn overlapping_health(&self, range_start: i64, range_end: i64) -> Vec<SegmentHealth> {
        overlapping_segments(&self.snapshot(), range_start, range_end)
            .into_iter()
            .map(|segment| segment.health)
            .collect()
    }
}

fn keep_hns(max_keep_ms: u64) -> i64 {
    (max_keep_ms.max(1_000) as i64)
        .saturating_mul(10_000)
        .saturating_add(WEBCAM_FILE_HNS)
}

fn remove_webcam_file(path: &str) {
    if path.is_empty() {
        return;
    }
    let path = Path::new(path);
    let _ = std::fs::remove_file(path);
}

/// Independent finalize ack. Gameplay wait_for_rotate must never wait on this.
#[derive(Debug)]
pub struct RotateAck {
    requested: AtomicBool,
    generation: AtomicU64,
    tick: Mutex<u64>,
    cv: Condvar,
}

impl Default for RotateAck {
    fn default() -> Self {
        Self {
            requested: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            tick: Mutex::new(0),
            cv: Condvar::new(),
        }
    }
}

impl RotateAck {
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn take(&self) -> bool {
        self.requested.swap(false, Ordering::SeqCst)
    }

    pub fn ack(&self) {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut tick) = self.tick.lock() {
            *tick = next;
        }
        self.cv.notify_all();
    }

    /// Wait until `generation` advances past `start_gen`, or `timeout`.
    /// Snapshot `start_gen` *before* `request()` so a fast ack still counts.
    pub fn wait_since(&self, start_gen: u64, timeout: Duration) -> bool {
        let Ok(tick) = self.tick.lock() else {
            return false;
        };
        if *tick > start_gen {
            return true;
        }
        match self.cv.wait_timeout(tick, timeout) {
            Ok((guard, _)) => *guard > start_gen,
            Err(_) => false,
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn webcam_dir(scratch: &Path) -> PathBuf {
    scratch.join("webcam")
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn segment_path(dir: &Path, index: u64) -> PathBuf {
    dir.join(format!("cam-{index:06}.mp4"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::clock::SEGMENT_HNS;

    fn valid(index: i64, path: &str) -> SourceSegment {
        let (start_hns, end_hns) = segment_bounds(index);
        SourceSegment {
            start_hns,
            end_hns,
            path: path.into(),
            health: SegmentHealth::Valid,
        }
    }

    #[test]
    fn webcam_rotate_timeout_is_bounded() {
        assert_eq!(WEBCAM_ROTATE_TIMEOUT, Duration::from_millis(400));
    }

    #[test]
    fn f10_picks_overlap_and_skips_gaps() {
        let mut ring = WebcamBuffer::new(30_000);
        ring.push(valid(0, "cam-0.mp4"));
        ring.push_gap(1);
        ring.push(valid(2, "cam-2.mp4"));
        ring.push(SourceSegment {
            start_hns: 60_000_000,
            end_hns: 80_000_000,
            path: "cam-3.mp4".into(),
            health: SegmentHealth::Failed,
        });
        let gameplay_start = SEGMENT_HNS - 2_000_000;
        let gameplay_end = SEGMENT_HNS * 3 + 1_000_000;
        assert_eq!(
            ring.overlapping_health(gameplay_start, gameplay_end),
            vec![
                SegmentHealth::Valid,
                SegmentHealth::Gap,
                SegmentHealth::Valid,
                SegmentHealth::Failed
            ]
        );
        assert_eq!(
            ring.remux_paths(gameplay_start, gameplay_end),
            vec![PathBuf::from("cam-0.mp4"), PathBuf::from("cam-2.mp4")]
        );
    }

    #[test]
    fn missing_webcam_is_an_empty_remux_not_a_failure() {
        let ring = WebcamBuffer::new(15_000);
        assert!(ring.remux_paths(0, 40_000_000).is_empty());
    }

    #[test]
    fn prune_keeps_replay_window_and_locked_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut ring = WebcamBuffer::new(4_000);
        for index in 0..6 {
            let path = dir.path().join(format!("cam-{index}.mp4"));
            std::fs::write(&path, b"seg").unwrap();
            ring.push(valid(index, path.to_str().unwrap()));
        }
        assert!(!dir.path().join("cam-0.mp4").exists());
        assert!(dir.path().join("cam-5.mp4").exists());
        ring.lock_range(SEGMENT_HNS * 4, SEGMENT_HNS * 6);
        ring.push(valid(6, "cam-6.mp4"));
        ring.push(valid(7, "cam-7.mp4"));
        assert!(dir.path().join("cam-4.mp4").exists());
        ring.unlock_all();
        assert!(!dir.path().join("cam-4.mp4").exists());
    }

    #[test]
    fn fill_gaps_before_inserts_missing_grid_cells() {
        let mut ring = WebcamBuffer::new(60_000);
        ring.push(valid(0, "cam-0.mp4"));
        ring.fill_gaps_before(3);
        ring.push(valid(3, "cam-3.mp4"));
        assert_eq!(
            ring.overlapping_health(0, SEGMENT_HNS * 4),
            vec![
                SegmentHealth::Valid,
                SegmentHealth::Gap,
                SegmentHealth::Gap,
                SegmentHealth::Valid
            ]
        );
    }

    #[test]
    fn rotate_ack_timeout_does_not_block() {
        let ack = RotateAck::default();
        let gen = ack.generation();
        ack.request();
        let started = std::time::Instant::now();
        assert!(!ack.wait_since(gen, Duration::from_millis(30)));
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn rotate_ack_returns_when_signaled() {
        let ack = std::sync::Arc::new(RotateAck::default());
        let waiter = std::sync::Arc::clone(&ack);
        let gen = ack.generation();
        ack.request();
        let handle = std::thread::spawn(move || waiter.wait_since(gen, Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(20));
        ack.ack();
        assert!(handle.join().unwrap());
    }

    #[test]
    fn fast_ack_before_wait_still_counts() {
        let ack = RotateAck::default();
        let gen = ack.generation();
        ack.request();
        ack.ack();
        assert!(ack.wait_since(gen, Duration::from_millis(30)));
    }
}
