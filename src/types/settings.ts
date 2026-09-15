import type { HotkeyAction } from "../utils/hotkeys";
import { DEFAULT_HOTKEYS } from "../utils/hotkeys";

export type ReplayDurationSeconds = 15 | 30 | 45 | 60 | 90 | 120 | 180 | 300;
export type CaptureResolution = "auto" | "native" | "720p" | "1080p" | "1440p" | "4k";
export type CaptureFps = 30 | 60 | 120;
export type BitratePreset = "low" | "medium" | "high" | "custom";
export type CodecPreference = "h264" | "h265" | "av1";
export type AutoUploadMode = "off" | "favorites" | "all";
export type CloudUploadWhen = "immediate" | "afterGame";
export type BandwidthLimit = "unlimited" | "50" | "25" | "10" | "5" | "1" | "custom";
export type ThemePreference = "dark" | "light" | "system";

export type WebcamPlacement = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type WebcamShape = "rectangle" | "rounded" | "circle";
export type GameplayVisualFilter = "none" | "bodycam" | "dashcam" | "vhs" | "cinematic";
export type PreviewBackgroundMode = "mock" | "dark";
/** Live Output Preview only. Does not change recording file size or encoder settings. */
export type PreviewQuality = "full" | "balanced" | "performance";
/** Per-source channel preparation before the stereo mix. */
export type AudioChannelMode = "auto" | "mono" | "stereo";

export function parseAudioChannelMode(value: unknown): AudioChannelMode {
  if (value === "mono" || value === "stereo" || value === "auto") return value;
  return "auto";
}

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

/**
 * Clip studio scene library, persisted on the settings document rather than in localStorage.
 *
 * Save Clip is reachable from the F10 hotkey and the tray with no frontend payload, so the Rust
 * side has to be able to read the clip scene on its own. These four types are hand-mirrored with
 * `ClipStudioSettings` and friends in src-tauri/src/settings.rs — there is no codegen, and
 * `set_document` re-serializes the whole document, so any field missing from the Rust structs is
 * silently dropped on the next write.
 *
 * They live here rather than in recording/scene.ts to avoid a cycle: scene.ts already imports
 * this module. Conversion to and from `RecordingScene` lives in recording/clipLibrary.ts.
 */
export interface SerializedClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `capability` is intentionally not persisted — the frontend re-derives it from `type`. */
export interface SerializedClipSource {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  order: number;
  transform: SerializedClipRect | null;
  crop: SerializedClipRect | null;
  settings: Record<string, unknown>;
}

/** `outputMode` is intentionally not persisted — clip scenes are always "layout, burn on save". */
export interface SerializedClipScene {
  id: string;
  name: string;
  sources: SerializedClipSource[];
}

export interface ClipStudioSettings {
  version: number;
  activeId: string;
  /** Empty means "seed me from the current settings" — see `seedClipLibrary`. */
  scenes: SerializedClipScene[];
}

export const CLIP_LIBRARY_VERSION = 1;

/** Region screenshot behaviour. Hand-mirrored with `ScreenshotSettings` in src-tauri/src/settings.rs. */
export interface ScreenshotSettings {
  /** Upload each screenshot and copy its share link. Signed-out users always get the image. */
  autoUpload: boolean;
  /** What lands on the clipboard after an upload succeeds. */
  copyMode: "link" | "image";
  /** Show the on-screen confirmation. */
  showOverlay: boolean;
}

export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = {
  autoUpload: true,
  copyMode: "link",
  showOverlay: true,
};

export function sanitizeScreenshotSettings(raw: unknown): ScreenshotSettings {
  const value = raw && typeof raw === "object" ? (raw as Partial<ScreenshotSettings>) : {};
  return {
    autoUpload: typeof value.autoUpload === "boolean" ? value.autoUpload : DEFAULT_SCREENSHOT_SETTINGS.autoUpload,
    copyMode: value.copyMode === "image" ? "image" : "link",
    showOverlay: typeof value.showOverlay === "boolean" ? value.showOverlay : DEFAULT_SCREENSHOT_SETTINGS.showOverlay,
  };
}

export const DEFAULT_CLIP_STUDIO: ClipStudioSettings = {
  version: CLIP_LIBRARY_VERSION,
  activeId: "",
  scenes: [],
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
  micChannelMode: AudioChannelMode;
  /** -1 = left, 0 = center, +1 = right. */
  micPan: number;
  gameAudioEnabled: boolean;
  gameAudioGain: number;
  gameAudioChannelMode: AudioChannelMode;
  gameAudioPan: number;
  discordAudioEnabled: boolean;
  discordAudioGain: number;
  extraApps: ExtraAudioApp[];
  systemAudioEnabled: boolean;
  /** Linear desktop / system-audio gain: 0 = mute, 1 = 100%, 2 = 200%. */
  systemAudioGain: number;
  systemAudioChannelMode: AudioChannelMode;
  systemAudioPan: number;
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
  /** Clip studio scene library. Layout and burn layers only — never changes what IR captures. */
  clipStudio: ClipStudioSettings;
  /** Region screenshots. Independent of Instant Replay. */
  screenshots: ScreenshotSettings;
  /** Live Output Preview resolution/pace. Does not change the recording. */
  previewQuality: PreviewQuality;
  /** Clip studio scene library. Untrusted JSON; sanitized before use. */
  clipSceneLibrary: unknown | null;
  /** Frozen clip composition snapshot for Save Clip / F10. */
  clipComposition: unknown | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  closeToTray: true,
  launchAtStartup: false,
  instantReplayEnabled: true,
  replayDurationSeconds: 60,
  resolution: "auto",
  fps: 60,
  encoder: "auto",
  bitrate: "medium",
  customBitrateKbps: 15000,
  codec: "h264",
  microphoneId: "default",
  audioOutputId: "default",
  micEnabled: false,
  micGain: 1,
  micChannelMode: "auto",
  micPan: 0,
  gameAudioEnabled: true,
  gameAudioGain: 1,
  gameAudioChannelMode: "auto",
  gameAudioPan: 0,
  discordAudioEnabled: false,
  discordAudioGain: 1,
  extraApps: [],
  systemAudioEnabled: false,
  systemAudioGain: 1,
  systemAudioChannelMode: "auto",
  systemAudioPan: 0,
  saveLocation: "",
  hotkeys: { ...DEFAULT_HOTKEYS },
  autoUpload: "all",
  cloudUploadWhen: "afterGame",
  uploadBandwidthLimit: "unlimited",
  customBandwidthKbps: 10000,
  pauseUploadsWhileGaming: true,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
  // Dark remains the default for existing and fresh installs.
  theme: "dark",
  onboardingCompleted: false,
  desktopShortcut: false,
  desktopShortcutPrompted: false,
  watermarkExports: true,
  clipSavedNotification: true,
  discordRichPresence: true,
  webcam: { ...DEFAULT_WEBCAM_SETTINGS },
  recordingVisuals: { ...DEFAULT_RECORDING_VISUALS, overlays: { ...DEFAULT_RECORDING_VISUALS.overlays } },
  clipStudio: { ...DEFAULT_CLIP_STUDIO, scenes: [] },
  screenshots: { ...DEFAULT_SCREENSHOT_SETTINGS },
  previewQuality: "balanced",
  clipSceneLibrary: null,
  clipComposition: null,
};
