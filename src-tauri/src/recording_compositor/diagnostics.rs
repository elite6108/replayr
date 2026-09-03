//! Recording-only compositor diagnostics. Never touches clip/IR logging.
//! Do not log source text contents or full private paths.

use std::time::Duration;

#[cfg(windows)]
use super::hw_encode::EncoderPipelineStats;

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

#[derive(Debug, Clone, Default)]
pub struct AudioStopStats {
    pub desktop_capture_started: bool,
    pub desktop_enabled: bool,
    pub desktop_samples_received: u64,
    pub desktop_samples_mixed: u64,
    pub mic_samples_received: u64,
    pub mic_samples_mixed: u64,
    pub game_samples_received: u64,
    pub game_samples_mixed: u64,
}

#[cfg(windows)]
pub fn log_stop(
    stats: &SessionStats,
    elapsed_ms: u128,
    pipe: &EncoderPipelineStats,
    audio: &AudioStopStats,
) {
    tracing::info!(
        capture = format!("{}x{}", stats.capture_w, stats.capture_h),
        output = format!("{}x{}", stats.output_w, stats.output_h),
        fps = stats.fps,
        encoder = stats.encoder,
        init_ms = stats.init_ms,
        capture_frames = stats.frames_received,
        composed_frames = stats.frames_composed,
        encoded = stats.frames_encoded,
        dropped = stats.frames_dropped,
        process_input_count = pipe.process_input,
        process_output_count = pipe.process_output,
        encoded_packet_count = pipe.process_output,
        muxed_video_packet_count = pipe.muxed,
        first_input_hns = pipe.first_input_hns,
        last_input_hns = pipe.last_input_hns,
        first_encoded_hns = pipe.first_encoded_hns,
        last_encoded_hns = pipe.last_encoded_hns,
        first_mux_hns = pipe.first_mux_hns,
        last_mux_hns = pipe.last_mux_hns,
        surfaces_acquired = pipe.surfaces_acquired,
        surfaces_released = pipe.surfaces_released,
        max_in_flight = pipe.max_in_flight,
        wait_count = pipe.wait_count,
        drain = pipe.drain,
        desktop_capture_started = audio.desktop_capture_started,
        desktop_enabled = audio.desktop_enabled,
        desktop_samples_received = audio.desktop_samples_received,
        desktop_samples_mixed = audio.desktop_samples_mixed,
        mic_samples_received = audio.mic_samples_received,
        mic_samples_mixed = audio.mic_samples_mixed,
        game_samples_received = audio.game_samples_received,
        game_samples_mixed = audio.game_samples_mixed,
        audio_encoder_input_frames = pipe.audio_encoder_input_frames,
        audio_encoded_packets = pipe.audio_encoded_packets,
        audio_muxed_packets = pipe.audio_muxed_packets,
        first_audio_hns = pipe.first_audio_hns,
        last_audio_hns = pipe.last_audio_hns,
        first_video_hns = pipe.first_mux_hns,
        last_video_hns = pipe.last_mux_hns,
        audio_track_created = pipe.audio_track_created,
        avg_compose_ms = format!("{:.2}", stats.avg_compose_ms()),
        max_compose_ms = format!("{:.2}", stats.max_compose_ms()),
        elapsed_ms,
        "composed session recording stopped"
    );
}

pub fn log_fail(stage: &str, err: &str) {
    tracing::warn!(stage, err, "composed session recording failed");
}
