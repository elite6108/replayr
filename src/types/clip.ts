import type { WebcamPlacement, WebcamShape } from "./settings";

export type LocalUploadStatus =
  | "local"
  | "queued"
  | "preparing"
  | "uploading"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface CloudClip {
  id: string;
  title: string | null;
  slug: string;
  status: "uploading" | "processing" | "ready" | "failed" | "deleted";
  visibility: "public" | "unlisted" | "private";
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  createdAt: string;
}

export interface LocalClip {
  localId: string;
  cloudClipId: string | null;
  filePath: string;
  thumbnailPath: string | null;
  gameId: string | null;
  createdAt: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  fileSize: number | null;
  uploadStatus: LocalUploadStatus;
  favorite: boolean;
  title: string | null;
  description: string | null;
  sourceClipId: string | null;
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  editorCropX?: number;
  sources?: ClipSource[];
}

export type ClipSourceKind = "gameplay" | "webcam" | string;
export type ClipSourceHealth = "valid" | "gap" | "failed" | string;

export interface ClipSourceLayout {
  placement: WebcamPlacement;
  shape: WebcamShape;
  width: number;
  /** Normalized left edge (0–1). With `y`, free placement overrides corners. */
  x?: number | null;
  /** Normalized top edge (0–1). With `x`, free placement overrides corners. */
  y?: number | null;
}

export interface ClipSource {
  id: number;
  clipId: string;
  sourceInstanceId: string;
  kind: ClipSourceKind;
  filePath: string;
  role: string;
  startHns: number;
  durationHns: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  health: ClipSourceHealth;
  layoutJson: string | null;
  createdAt: string;
}
