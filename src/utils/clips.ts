import type { ClipSource, ClipSourceLayout, CloudClip, LocalClip } from "../types/clip";
import type { WebcamPlacement, WebcamShape } from "../types/settings";
import { DEFAULT_WEBCAM_SETTINGS } from "../types/settings";

export function normalizeUploadStatus(status: string | null | undefined): string {
  return (status || "").trim().toLowerCase();
}

export function findLinkedCloudClip(clip: LocalClip, cloudClips: CloudClip[]): CloudClip | undefined {
  if (clip.cloudClipId) {
    const exact = cloudClips.find((item) => item.id === clip.cloudClipId);
    if (exact) return exact;
  }
  return cloudClips.find((item) => clipsLookLikeSame(clip, item));
}

export function isLocalClipInCloud(clip: LocalClip, cloudClips: CloudClip[] = []): boolean {
  const status = normalizeUploadStatus(clip.uploadStatus);
  if (status === "completed" || Boolean(clip.cloudClipId)) return true;
  return Boolean(findLinkedCloudClip(clip, cloudClips));
}

function clipsLookLikeSame(local: LocalClip, cloud: CloudClip): boolean {
  if (cloud.status === "deleted") return false;
  const title = (local.title || "").trim().toLowerCase();
  const cloudTitle = (cloud.title || "").trim().toLowerCase();
  const titled = Boolean(title && title === cloudTitle && title !== "untitled clip");
  const sizeClose =
    local.fileSize != null &&
    cloud.fileSizeBytes != null &&
    Math.abs(local.fileSize - cloud.fileSizeBytes) <= 2048;
  const durationClose =
    local.durationMs != null &&
    cloud.durationMs != null &&
    Math.abs(local.durationMs - cloud.durationMs) <= 1500;
  return (titled && (sizeClose || durationClose)) || Boolean(sizeClose && durationClose);
}

export function clipWebcamSource(clip: LocalClip | null | undefined): ClipSource | null {
  return (
    clip?.sources?.find(
      (source) => source.kind === "webcam" && source.health.toLowerCase() === "valid" && Boolean(source.filePath),
    ) ?? null
  );
}

export function parseSourceLayout(raw: string | null | undefined): ClipSourceLayout {
  const fallback: ClipSourceLayout = {
    placement: DEFAULT_WEBCAM_SETTINGS.defaultPlacement,
    shape: DEFAULT_WEBCAM_SETTINGS.defaultShape,
    width: DEFAULT_WEBCAM_SETTINGS.defaultWidth,
  };
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ClipSourceLayout>;
    const placement = parsed.placement as WebcamPlacement;
    const shape = parsed.shape as WebcamShape;
    const width = Number(parsed.width);
    return {
      placement: ["top-left", "top-right", "bottom-left", "bottom-right"].includes(placement)
        ? placement
        : fallback.placement,
      shape: ["rectangle", "rounded", "circle"].includes(shape) ? shape : fallback.shape,
      width: Number.isFinite(width) ? Math.max(0.12, Math.min(0.4, width)) : fallback.width,
    };
  } catch {
    return fallback;
  }
}
