import type { HotkeyAction } from "../utils/hotkeys";
import { DEFAULT_HOTKEYS } from "../utils/hotkeys";

export type ReplayDurationSeconds = 15 | 30 | 45 | 60 | 90 | 120 | 180 | 300;
export type CaptureResolution = "native" | "1080p" | "720p";
export type CaptureFps = 30 | 60 | 120;
export type BitratePreset = "low" | "medium" | "high" | "custom";
export type CodecPreference = "h264" | "h265" | "av1";
export type AutoUploadMode = "off" | "favorites" | "all";
export type BandwidthLimit = "unlimited" | "50" | "25" | "10" | "5" | "1" | "custom";
export type ThemePreference = "dark";

export interface AppSettings {
  closeToTray: boolean;
  launchAtStartup: boolean;
  instantReplayEnabled: boolean;
  replayDurationSeconds: ReplayDurationSeconds;
  resolution: CaptureResolution;
  fps: CaptureFps;
  encoder: "auto";
  bitrate: BitratePreset;
  customBitrateKbps: number;
  codec: CodecPreference;
  microphoneId: string;
  audioOutputId: string;
  micEnabled: boolean;
  systemAudioEnabled: boolean;
  saveLocation: string;
  hotkeys: Record<HotkeyAction, string>;
  autoUpload: AutoUploadMode;
  uploadBandwidthLimit: BandwidthLimit;
  customBandwidthKbps: number;
  pauseUploadsWhileGaming: boolean;
  minFreeDiskBytes: number;
  theme: ThemePreference;
  onboardingCompleted: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  closeToTray: true,
  launchAtStartup: false,
  instantReplayEnabled: true,
  replayDurationSeconds: 60,
  resolution: "native",
  fps: 60,
  encoder: "auto",
  bitrate: "medium",
  customBitrateKbps: 15000,
  codec: "h264",
  microphoneId: "default",
  audioOutputId: "default",
  micEnabled: true,
  systemAudioEnabled: true,
  saveLocation: "",
  hotkeys: { ...DEFAULT_HOTKEYS },
  autoUpload: "all",
  uploadBandwidthLimit: "unlimited",
  customBandwidthKbps: 10000,
  pauseUploadsWhileGaming: true,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
  theme: "dark",
  onboardingCompleted: false,
};
