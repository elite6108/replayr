use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use wasapi::{
    Direction, SampleType, StreamMode, WaveFormat, get_default_device, initialize_mta,
};

pub struct LoopbackCapture {
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl LoopbackCapture {
    pub fn start() -> Option<Self> {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let buffer_thread = buffer.clone();
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                if let Err(err) = capture_loop(buffer_thread, stop_thread) {
                    tracing::warn!("WASAPI loopback stopped: {err}");
                }
            })
            .ok()?;
        Some(Self {
            buffer,
            stop,
            join: Some(join),
        })
    }

    pub fn take(&self) -> Vec<u8> {
        self.buffer
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default()
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn capture_loop(
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = initialize_mta().ok();
    let device = get_default_device(&Direction::Render)?;
    let mut audio_client = device.get_iaudioclient()?;
    let desired_format = WaveFormat::new(16, 16, &SampleType::Int, 48000, 2, None);
    let (_default_period, min_period) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client.initialize_client(&desired_format, &Direction::Capture, &mode)?;
    let event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;
    let mut queue = VecDeque::new();
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(200).is_err() {
            continue;
        }
        capture_client.read_from_device_to_deque(&mut queue)?;
        if queue.is_empty() {
            continue;
        }
        if let Ok(mut guard) = buffer.lock() {
            guard.extend(queue.drain(..));
            const MAX_BUFFER: usize = 48000 * 2 * 2;
            if guard.len() > MAX_BUFFER {
                let overflow = guard.len() - MAX_BUFFER;
                guard.drain(..overflow);
            }
        }
    }
    let _ = audio_client.stop_stream();
    Ok(())
}
