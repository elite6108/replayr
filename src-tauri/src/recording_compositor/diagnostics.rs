//! Recording-only compositor diagnostics. Never touches clip/IR logging.
//! Do not log source text contents or full private paths.

use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct SessionStats {
    pub capture_w: u32,
    pub capture_h: u32,
    pub output_w: u32,
    pub output_h: u32,
    pub fps: u32,
    pub encoder: &'static str,
    pub init_ms: u128,
    pub frames_received: u64,
    pub frames_composed: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub compose_ns_total: u128,
    pub compose_ns_max: u128,
}

impl SessionStats {
    pub fn note_compose(&mut self, elapsed: Duration) {
        let ns = elapsed.as_nanos();
        self.compose_ns_total = self.compose_ns_total.saturating_add(ns);
        if ns > self.compose_ns_max {
            self.compose_ns_max = ns;
        }
        self.frames_composed = self.frames_composed.saturating_add(1);
    }

    pub fn avg_compose_ms(&self) -> f64 {
        if self.frames_composed == 0 {
            return 0.0;
        }
        (self.compose_ns_total as f64 / self.frames_composed as f64) / 1_000_000.0
    }

    pub fn max_compose_ms(&self) -> f64 {
        self.compose_ns_max as f64 / 1_000_000.0
    }
}

pub fn file_label(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or("session.mp4")
}

pub fn log_start(canvas_w: u32, canvas_h: u32, fps: u32, webcam: bool, path: &str) {
    tracing::info!(
        canvas = format!("{canvas_w}x{canvas_h}"),
        fps,
        webcam,
        file = file_label(path),
        "composed session recording starting"
    );
}

pub fn log_ready(encoder: &str, audio: bool, gpu: &str, init_ms: u128) {
    tracing::info!(
        encoder,
        audio,
        adapter = gpu,
        init_ms,
        "composed session encoder ready"
    );
}

pub fn log_stop(stats: &SessionStats, elapsed_ms: u128) {
    tracing::info!(
        capture = format!("{}x{}", stats.capture_w, stats.capture_h),
        output = format!("{}x{}", stats.output_w, stats.output_h),
        fps = stats.fps,
        encoder = stats.encoder,
        init_ms = stats.init_ms,
        received = stats.frames_received,
        composed = stats.frames_composed,
        encoded = stats.frames_encoded,
        dropped = stats.frames_dropped,
        avg_compose_ms = format!("{:.2}", stats.avg_compose_ms()),
        max_compose_ms = format!("{:.2}", stats.max_compose_ms()),
        elapsed_ms,
        "composed session recording stopped"
    );
}

pub fn log_fail(stage: &str, err: &str) {
    tracing::warn!(stage, err, "composed session recording failed");
}
