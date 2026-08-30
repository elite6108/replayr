fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--copy-remux") {
        if args.len() < 4 {
            eprintln!("usage: compose-nv12 --copy-remux <src.mp4> <dest.mp4>");
            std::process::exit(2);
        }
        match replay_lib::remux_composed_mp4(
            std::path::Path::new(&args[2]),
            std::path::Path::new(&args[3]),
        ) {
            Ok(stats) => {
                println!(
                    "copy-remuxed {} video / {} audio samples in {} ms",
                    stats.video_samples, stats.audio_samples, stats.elapsed_ms
                );
                println!("video_sha256={}", stats.video_sha256);
                println!("audio_sha256={}", stats.audio_sha256);
                return;
            }
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    if args.get(1).map(String::as_str) == Some("--faststart") {
        let Some(path) = args.get(2) else {
            eprintln!("usage: compose-nv12 --faststart <file.mp4>");
            std::process::exit(2);
        };
        match replay_lib::faststart_mp4_in_place(std::path::Path::new(path)) {
            Ok(rewrote) => {
                println!(
                    "{}",
                    if rewrote {
                        "relocated moov before mdat"
                    } else {
                        "already had moov before mdat"
                    }
                );
                return;
            }
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    if args.get(1).map(String::as_str) == Some("--blank-mft") {
        let frames = args
            .get(2)
            .and_then(|value| value.parse().ok())
            .unwrap_or(12_000);
        match replay_lib::blank_direct_mft_long_test(frames) {
            Ok(summary) => {
                println!("{summary}");
                return;
            }
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        }
    }
    if args.len() < 4 {
        eprintln!("usage: compose-nv12 <gameplay.mp4> <webcam.mp4> <output.mp4>");
        eprintln!("       compose-nv12 --blank-mft [frames]");
        eprintln!("       compose-nv12 --faststart <file.mp4>");
        eprintln!("       compose-nv12 --copy-remux <src.mp4> <dest.mp4>");
        std::process::exit(2);
    }
    let started = std::time::Instant::now();
    match replay_lib::compose_webcam_clip(
        std::path::Path::new(&args[1]),
        std::path::Path::new(&args[2]),
        std::path::Path::new(&args[3]),
        std::time::Duration::from_secs(240),
    ) {
        Ok(written_ms) => {
            let elapsed_ms = started.elapsed().as_millis();
            let size = std::fs::metadata(&args[3])
                .map(|meta| meta.len())
                .unwrap_or(0);
            println!("composed {written_ms} ms video ({size} bytes) in {elapsed_ms} ms");
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
