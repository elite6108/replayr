use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pinned: bool,
    pub locked: bool,
}

#[derive(Debug, Default)]
pub struct ReplayBuffer {
    segments: VecDeque<Segment>,
    max_duration_ms: u64,
    session_active: bool,
}

impl ReplayBuffer {
    pub fn new(max_duration_ms: u64) -> Self {
        Self {
            segments: VecDeque::new(),
            max_duration_ms: max_duration_ms.max(1_000),
            session_active: false,
        }
    }

    pub fn set_max_duration_ms(&mut self, max_duration_ms: u64) {
        self.max_duration_ms = max_duration_ms.max(1_000);
    }

    pub fn total_ms(&self) -> u64 {
        self.segments.iter().map(|segment| segment.duration_ms).sum()
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        self.segments.iter().map(|segment| segment.path.clone()).collect()
    }

    pub fn push(&mut self, mut segment: Segment) {
        if self.session_active {
            segment.pinned = true;
        }
        self.segments.push_back(segment);
        self.prune(true);
    }

    pub fn begin_session(&mut self) {
        self.session_active = true;
    }

    pub fn end_session(&mut self) {
        self.session_active = false;
        for segment in &mut self.segments {
            segment.pinned = false;
        }
        self.prune(true);
    }

    pub fn session_paths(&self) -> Vec<PathBuf> {
        self.segments
            .iter()
            .filter(|segment| segment.pinned)
            .map(|segment| segment.path.clone())
            .collect()
    }

    pub fn clip_paths(&mut self, duration_ms: u64) -> Vec<PathBuf> {
        let want = duration_ms.max(1);
        let mut acc = 0_u64;
        let mut chosen = Vec::new();
        for segment in self.segments.iter_mut().rev() {
            segment.locked = true;
            chosen.push(segment.path.clone());
            acc = acc.saturating_add(segment.duration_ms);
            if acc >= want {
                break;
            }
        }
        chosen.reverse();
        chosen
    }

    pub fn unlock_all(&mut self) {
        for segment in &mut self.segments {
            segment.locked = false;
        }
    }

    pub fn prune(&mut self, delete_files: bool) {
        loop {
            if self.segments.is_empty() {
                break;
            }
            let front = self.segments.front().expect("non-empty");
            if front.pinned || front.locked {
                break;
            }
            let after: u64 = self.segments.iter().skip(1).map(|segment| segment.duration_ms).sum();
            if after < self.max_duration_ms {
                break;
            }
            let dropped = self.segments.pop_front().expect("non-empty");
            if delete_files {
                let _ = std::fs::remove_file(&dropped.path);
            }
        }
    }

    pub fn clear(&mut self, delete_files: bool) {
        while let Some(segment) = self.segments.pop_front() {
            if delete_files {
                let _ = std::fs::remove_file(&segment.path);
            }
        }
    }
}

/// Delete scratch files that are not part of the live ring (or the file currently being written).
pub fn sweep_dir(dir: &Path, keep: &[PathBuf]) {
    let keep: HashSet<&Path> = keep.iter().map(PathBuf::as_path).collect();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !keep.contains(path.as_path()) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn seg(id: u32, duration_ms: u64, pinned: bool) -> Segment {
        Segment {
            path: PathBuf::from(format!("seg-{id}.mp4")),
            duration_ms,
            width: 1920,
            height: 1080,
            fps: 60,
            pinned,
            locked: false,
        }
    }

    #[test]
    fn ring_keeps_at_least_max_duration() {
        let mut buffer = ReplayBuffer::new(5_000);
        for id in 0..10 {
            buffer.push(seg(id, 2_000, false));
        }
        assert_eq!(buffer.segments.len(), 3);
        assert_eq!(buffer.total_ms(), 6_000);
        assert_eq!(
            buffer
                .segments
                .iter()
                .map(|segment| segment.path.file_stem().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["seg-7", "seg-8", "seg-9"]
        );
    }

    #[test]
    fn pinned_session_segments_are_not_pruned() {
        let mut buffer = ReplayBuffer::new(5_000);
        buffer.push(seg(1, 2_000, false));
        buffer.begin_session();
        for id in 2..12 {
            buffer.push(seg(id, 2_000, false));
        }
        assert!(buffer.total_ms() >= 20_000);
        assert_eq!(buffer.session_paths().len(), 10);
        buffer.end_session();
        assert_eq!(buffer.total_ms(), 6_000);
    }

    #[test]
    fn clip_paths_walk_backward_and_lock() {
        let mut buffer = ReplayBuffer::new(60_000);
        for id in 0..5 {
            buffer.push(seg(id, 2_000, false));
        }
        let paths = buffer.clip_paths(5_000);
        assert_eq!(paths.len(), 3);
        assert!(paths[0].ends_with("seg-2.mp4"));
        assert!(buffer.segments.iter().rev().take(3).all(|segment| segment.locked));
        buffer.unlock_all();
        assert!(buffer.segments.iter().all(|segment| !segment.locked));
    }

    #[test]
    fn sweep_deletes_files_outside_the_ring() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("seg-live.mp4");
        let stale = dir.path().join("seg-stale.mp4");
        std::fs::write(&live, b"live").unwrap();
        std::fs::write(&stale, b"stale").unwrap();
        sweep_dir(dir.path(), &[live.clone()]);
        assert!(live.exists());
        assert!(!stale.exists());
    }
}
