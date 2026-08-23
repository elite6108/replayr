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
}
