import type { HotkeyAction } from "../utils/hotkeys";
import { DEFAULT_HOTKEYS } from "../utils/hotkeys";

export type ReplayDurationSeconds = 15 | 30 | 45 | 60 | 90 | 120 | 180 | 300;
export type CaptureResolution = "native" | "1080p" | "720p";
export type CaptureFps = 30 | 60 | 120;
export type BitratePreset = "low" | "medium" | "high" | "custom";
export type CodecPreference = "h264" | "h265" | "av1";
export type AutoUploadMode = "off" | "favorites" | "all";
export type CloudUploadWhen = "immediate" | "afterGame";
export type BandwidthLimit = "unlimited" | "50" | "25" | "10" | "5" | "1" | "custom";
export type ThemePreference = "dark";

export type WebcamPlacement = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type WebcamShape = "rectangle" | "rounded" | "circle";
export type GameplayVisualFilter = "none" | "bodycam" | "dashcam" | "vhs" | "cinematic";
export type PreviewBackgroundMode = "mock" | "dark";

export interface RecordingOverlaySettings {
  recIndicator: boolean;
  timestamp: boolean;
}

/** Canonical Recording Visuals. Phase 3 may add optional per-filter params as siblings. */
export interface RecordingVisualSettings {
  filter: GameplayVisualFilter;
  overlays: RecordingOverlaySettings;
}

export const DEFAULT_RECORDING_VISUALS: RecordingVisualSettings = {
  filter: "none",
  overlays: {
    recIndicator: false,
    timestamp: false,
  },
};

export interface WebcamSettings {
  enabled: boolean;
  deviceId: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  mirrorPreview: boolean;
  mirrorRecording: boolean;
  defaultPlacement: WebcamPlacement;
  defaultShape: WebcamShape;
  defaultWidth: number;
}

export const DEFAULT_WEBCAM_SETTINGS: WebcamSettings = {
  enabled: false,
  deviceId: "",
  name: "Webcam",
  width: 1280,
  height: 720,
  fps: 30,
  mirrorPreview: true,
  mirrorRecording: false,
  defaultPlacement: "bottom-right",
  defaultShape: "rounded",
  defaultWidth: 0.22,
};

export interface ExtraAudioApp {
  id: string;
  exe: string;
  displayName: string;
  enabled: boolean;
  gain: number;
}

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
  /** Linear gain: 0 = mute, 1 = 100%, 2 = 200%. */
  micGain: number;
  gameAudioEnabled: boolean;
  gameAudioGain: number;
  discordAudioEnabled: boolean;
  discordAudioGain: number;
  extraApps: ExtraAudioApp[];
  systemAudioEnabled: boolean;
  saveLocation: string;
  hotkeys: Record<HotkeyAction, string>;
  autoUpload: AutoUploadMode;
  cloudUploadWhen: CloudUploadWhen;
  uploadBandwidthLimit: BandwidthLimit;
  customBandwidthKbps: number;
  pauseUploadsWhileGaming: boolean;
  minFreeDiskBytes: number;
  theme: ThemePreference;
  onboardingCompleted: boolean;
  desktopShortcut: boolean;
  desktopShortcutPrompted: boolean;
  watermarkExports: boolean;
  clipSavedNotification: boolean;
  discordRichPresence: boolean;
  webcam: WebcamSettings;
  recordingVisuals: RecordingVisualSettings;
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
  micEnabled: false,
  micGain: 1,
  gameAudioEnabled: true,
  gameAudioGain: 1,
  discordAudioEnabled: false,
  discordAudioGain: 1,
  extraApps: [],
  systemAudioEnabled: false,
  saveLocation: "",
  hotkeys: { ...DEFAULT_HOTKEYS },
  autoUpload: "all",
  cloudUploadWhen: "afterGame",
  uploadBandwidthLimit: "unlimited",
  customBandwidthKbps: 10000,
  pauseUploadsWhileGaming: true,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
  theme: "dark",
  onboardingCompleted: false,
  desktopShortcut: false,
  desktopShortcutPrompted: false,
  watermarkExports: true,
  clipSavedNotification: true,
  discordRichPresence: true,
  webcam: { ...DEFAULT_WEBCAM_SETTINGS },
  recordingVisuals: { ...DEFAULT_RECORDING_VISUALS, overlays: { ...DEFAULT_RECORDING_VISUALS.overlays } },
};
