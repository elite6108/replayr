export type UploadQueuePhase = "queued" | "preparing" | "uploading" | "processing";

export interface UploadQueueItem {
  localId: string;
  title: string;
  phase: UploadQueuePhase;
  bytesUploaded: number;
  bytesTotal: number;
  startedAt: number | null;
}

export interface CloudUploadEvent {
  localId?: string;
  status?: string;
  detail?: string | null;
  phase?: string;
  bytesUploaded?: number | null;
  bytesTotal?: number | null;
}

export function isUploadQueuePhase(value: string | undefined): value is UploadQueuePhase {
  return value === "queued" || value === "preparing" || value === "uploading" || value === "processing";
}
