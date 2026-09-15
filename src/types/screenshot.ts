/** Hand-mirrored with `ScreenshotRecord` in src-tauri/src/snip/store.rs. */
export type ScreenshotUploadStatus = "local" | "uploading" | "ready" | "failed" | "evicted" | "deleted";

export interface Screenshot {
  id: string;
  filePath: string;
  thumbPath: string | null;
  width: number;
  height: number;
  fileSize: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  cloudId: string | null;
  slug: string | null;
  shareUrl: string | null;
  uploadStatus: ScreenshotUploadStatus;
  uploadError: string | null;
}
