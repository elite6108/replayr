import type { AppSettings, BitratePreset, CaptureResolution } from "../types/settings";

/** Mirrors Rust `resolve_recording_bitrate` for Settings estimates only. */
const BASE_PIXEL_RATE = 1920 * 1080 * 60;
const MIN_BPS = 4_000_000;
const MAX_BPS = 120_000_000;

function clampBps(bps: number): number {
  return Math.max(MIN_BPS, Math.min(MAX_BPS, Math.round(bps)));
}

function hintSize(resolution: CaptureResolution): { width: number; height: number } {
  switch (resolution) {
    case "720p":
      return { width: 1280, height: 720 };
    case "1440p":
      return { width: 2560, height: 1440 };
    case "4k":
      return { width: 3840, height: 2160 };
    case "native":
      // Estimate only — actual native size is negotiated at record time.
      return { width: 2560, height: 1440 };
    case "auto":
    case "1080p":
    default:
      return { width: 1920, height: 1080 };
  }
}

export function estimateRecordingBitrateBps(settings: Pick<AppSettings, "resolution" | "fps" | "bitrate" | "customBitrateKbps">): number {
  const preset = settings.bitrate;
  if (preset === "custom") {
    return clampBps(Math.max(0, settings.customBitrateKbps) * 1000);
  }
  const { width, height } = hintSize(settings.resolution);
  const fps = Math.max(1, Math.min(60, settings.fps));
  const scale = Math.max(0.25, (width * height * fps) / BASE_PIXEL_RATE);
  const [anchor, exponent, maxMult] =
    preset === "low"
      ? [8_000_000, 0.92, 4]
      : preset === "high"
        ? [35_000_000, 0.95, 3]
        : [15_000_000, 0.9, 4];
  const mult = Math.min(maxMult, Math.max(0.25, scale ** exponent));
  return clampBps(anchor * mult);
}

export function formatBitrateEstimate(settings: AppSettings): string {
  const bps = estimateRecordingBitrateBps(settings);
  const mbps = bps / 1_000_000;
  const mbMin = Math.max(1, Math.round(mbps * 7.5));
  const { width, height } = hintSize(settings.resolution);
  const fps = Math.max(24, Math.min(60, settings.fps));
  const presetLabel =
    settings.bitrate === "low"
      ? "Low"
      : settings.bitrate === "high"
        ? "High"
        : settings.bitrate === "custom"
          ? "Custom"
          : "Medium";
  return `${presetLabel} ≈ ${mbps.toFixed(0)} Mbps at ${width}×${height} ${fps} FPS (~${mbMin} MB/min, approximate)`;
}

export type { BitratePreset };
