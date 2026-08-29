import type { LocalClip, LocalUploadStatus } from "../types/clip";
import type { DetectedGameSnapshot } from "../types/game";
import type { RecordingStatus, ReplayStatus } from "../types/recording";
import type { AppSettings } from "../types/settings";
import { isVideoPath } from "../utils/format";

const BUSY_UPLOAD: LocalUploadStatus[] = ["queued", "preparing", "uploading", "processing"];

export function isUploadBusy(status: LocalUploadStatus): boolean {
  return BUSY_UPLOAD.includes(status);
}

export function isUploadSettled(clip: LocalClip | undefined): boolean {
  if (!clip) return false;
  return clip.uploadStatus === "completed" || isUploadBusy(clip.uploadStatus);
}

export function shouldAutoUpload(
  clip: LocalClip | undefined,
  settings: AppSettings,
  signedIn: boolean,
): boolean {
  if (!clip || !isVideoPath(clip.filePath)) return false;
  if (isUploadSettled(clip)) return false;
  if (!signedIn) return false;
  if (settings.autoUpload === "off") return false;
  if (settings.autoUpload === "favorites") return clip.favorite;
  return true;
}

export function isCaptureTargetingGame(target: string | null | undefined): boolean {
  const trimmed = (target || "").trim();
  if (!trimmed) return false;
  return !/^(display|window)$/i.test(trimmed);
}

export function isInGame(
  detection: Pick<DetectedGameSnapshot, "slug">,
  recording: { status: Pick<RecordingStatus, "active" | "target">; replay: Pick<ReplayStatus, "active" | "target"> },
): boolean {
  if (detection.slug) return true;
  if (recording.status.active && isCaptureTargetingGame(recording.status.target)) return true;
  if (recording.replay.active && isCaptureTargetingGame(recording.replay.target)) return true;
  if (recording.status.active && !(recording.status.target || "").trim()) return true;
  return false;
}

export function shouldDeferUpload(
  settings: AppSettings,
  detection: Pick<DetectedGameSnapshot, "slug">,
  recording: { status: Pick<RecordingStatus, "active" | "target">; replay: Pick<ReplayStatus, "active" | "target"> },
): boolean {
  return settings.cloudUploadWhen === "afterGame" && isInGame(detection, recording);
}
