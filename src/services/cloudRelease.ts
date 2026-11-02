import type { LocalClip } from "../types/clip";

/** The local file may be removed only after this clip's own cloud copy is ready. */
export function shouldReleaseLocalCopy(
  clip: Pick<LocalClip, "releaseLocal" | "cloudClipId" | "uploadStatus"> | null | undefined,
): boolean {
  if (!clip?.releaseLocal) return false;
  if (!clip.cloudClipId) return false;
  return clip.uploadStatus === "completed";
}

/** A cloud-only clip that has not started uploading yet. */
export function isUnsentCloudOnly(clip: Pick<LocalClip, "releaseLocal" | "uploadStatus">): boolean {
  return clip.releaseLocal === true && clip.uploadStatus === "local";
}
