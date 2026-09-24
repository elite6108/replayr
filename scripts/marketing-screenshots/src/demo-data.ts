import type { LocalClip, CloudClip } from "../../../src/types/clip";
import type { AppSettings } from "../../../src/types/settings";
import { DEFAULT_SETTINGS } from "../../../src/types/settings";
import type { AudioEngineStatus, AudioSourceStatus } from "../../../src/types/audio";
import type { ReplayStatus, RecordingStatus } from "../../../src/types/recording";
import { IDLE_RECORDING } from "../../../src/types/recording";
import { IDLE_CAMERA_STATUS } from "../../../src/types/camera";
import { EMPTY_DETECTION } from "../../../src/types/game";

/** Windows-style library folder. No real user path. */
const LIBRARY = "C:\\Users\\You\\Videos\\Replayr";

function audioSource(
  id: string,
  displayName: string,
  peak: number,
  enabled = true,
): AudioSourceStatus {
  return {
    id,
    displayName,
    enabled,
    running: enabled,
    capturing: enabled,
    isolationFailed: false,
    status: enabled ? "ok" : "off",
    peak,
    gain: 1,
  };
}

function livePeak(phase: number, amp: number) {
  const t = Date.now() / 1000;
  return Math.max(0, Math.min(1, amp * (0.28 + 0.72 * Math.abs(Math.sin(t * 2.15 + phase)))));
}

export function marketingSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    onboardingCompleted: true,
    desktopShortcutPrompted: true,
    desktopShortcut: true,
    instantReplayEnabled: true,
    replayDurationSeconds: 60,
    resolution: "1080p",
    fps: 60,
    bitrate: "high",
    micEnabled: true,
    micGain: 0.85,
    gameAudioEnabled: true,
    gameAudioGain: 1,
    systemAudioEnabled: true,
    systemAudioGain: 0.7,
    saveLocation: LIBRARY,
    theme: "dark",
    webcam: {
      ...DEFAULT_SETTINGS.webcam,
      enabled: true,
      deviceId: "cam-0",
      name: "Webcam",
    },
    recordingVisuals: {
      filter: "none",
      overlays: { recIndicator: true, timestamp: true },
    },
  };
}

export function marketingReplay(): ReplayStatus {
  return {
    enabled: true,
    active: true,
    bufferedMs: 47_000,
    durationMs: 60_000,
    target: null,
    error: null,
    diskFreeBytes: null,
    diskBlocked: false,
    saving: false,
  };
}

export function marketingRecording(): RecordingStatus {
  return { ...IDLE_RECORDING };
}

export function marketingAudioStatus(): AudioEngineStatus {
  return {
    processLoopbackSupported: true,
    osBuild: 22631,
    extraCount: 0,
    extraCap: 4,
    game: audioSource("game", "Game", livePeak(0.2, 0.62)),
    desktop: audioSource("desktop", "Desktop", livePeak(1.1, 0.28)),
    discord: audioSource("discord", "Discord", 0, false),
    extras: [],
    detectedExtras: [],
  };
}

export function marketingMicLevel() {
  return livePeak(2.4, 0.4);
}

export const MARKETING_DISPLAYS = [
  {
    id: "display-1",
    name: "Display 1",
    width: 1920,
    height: 1080,
    refreshRate: 144,
    isPrimary: true,
    x: 0,
    y: 0,
  },
];

export const MARKETING_CAMERAS = [{ id: "cam-0", name: "Webcam" }];

export function marketingCameraStatus() {
  return {
    ...IDLE_CAMERA_STATUS,
    enabled: true,
    availability: "ready" as const,
    deviceId: "cam-0",
    deviceName: "Webcam",
    width: 1280,
    height: 720,
    fps: 30,
  };
}

export const MARKETING_DETECTION = { ...EMPTY_DETECTION };

function localClip(
  index: number,
  patch: Partial<LocalClip>,
): LocalClip {
  return {
    localId: `local-${index}`,
    cloudClipId: patch.cloudClipId ?? null,
    filePath: `${LIBRARY}\\clip-${index}.mp4`,
    thumbnailPath: `/thumbs/clip-${index}.svg`,
    gameId: null,
    createdAt: patch.createdAt ?? "2026-09-14T18:12:00.000Z",
    durationMs: patch.durationMs ?? 32_000,
    width: 1920,
    height: 1080,
    fps: 60,
    fileSize: patch.fileSize ?? 18_400_000,
    uploadStatus: patch.uploadStatus ?? "local",
    favorite: patch.favorite ?? false,
    title: patch.title ?? "Untitled clip",
    description: null,
    sourceClipId: null,
    sourceStartMs: null,
    sourceEndMs: null,
  };
}

export const MARKETING_LOCAL_CLIPS: LocalClip[] = [
  localClip(1, {
    title: "Untitled clip",
    favorite: true,
    uploadStatus: "local",
    createdAt: "2026-09-15T21:04:00.000Z",
    durationMs: 28_400,
  }),
  localClip(2, {
    title: "Untitled clip",
    uploadStatus: "completed",
    cloudClipId: "cloud-public",
    createdAt: "2026-09-15T19:40:00.000Z",
    durationMs: 54_000,
  }),
  localClip(3, {
    title: "Recording",
    uploadStatus: "local",
    createdAt: "2026-09-14T23:11:00.000Z",
    durationMs: 186_000,
    fileSize: 92_000_000,
  }),
  localClip(4, {
    title: "Untitled clip",
    uploadStatus: "local",
    createdAt: "2026-09-13T16:22:00.000Z",
    durationMs: 15_000,
  }),
  localClip(5, {
    title: "Recording",
    favorite: true,
    uploadStatus: "completed",
    cloudClipId: "cloud-unlisted",
    createdAt: "2026-09-12T20:05:00.000Z",
    durationMs: 61_000,
  }),
  localClip(6, {
    title: "Untitled clip",
    uploadStatus: "local",
    createdAt: "2026-09-11T14:48:00.000Z",
    durationMs: 42_000,
  }),
];

export const MARKETING_CLOUD_CLIPS: CloudClip[] = [
  {
    id: "cloud-public",
    title: "Untitled clip",
    slug: "public-demo",
    status: "ready",
    visibility: "public",
    durationMs: 54_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 22_400_000,
    createdAt: "2026-09-15T19:40:00.000Z",
    thumbnailUrl: "/thumbs/clip-2.svg",
    playbackUrl: null,
  },
  {
    id: "cloud-unlisted",
    title: "Recording",
    slug: "unlisted-demo",
    status: "ready",
    visibility: "unlisted",
    durationMs: 61_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 28_100_000,
    createdAt: "2026-09-12T20:05:00.000Z",
    thumbnailUrl: "/thumbs/clip-5.svg",
    playbackUrl: null,
  },
  {
    id: "cloud-private",
    title: "Untitled clip",
    slug: "private-demo",
    status: "ready",
    visibility: "private",
    durationMs: 33_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 16_200_000,
    createdAt: "2026-09-10T11:18:00.000Z",
    thumbnailUrl: "/thumbs/clip-1.svg",
    playbackUrl: null,
  },
];
