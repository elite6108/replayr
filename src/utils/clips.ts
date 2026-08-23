import type { CloudClip, LocalClip } from "../types/clip";

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
