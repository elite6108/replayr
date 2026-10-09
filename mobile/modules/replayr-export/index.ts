import { requireNativeModule } from "expo-modules-core";

export type ExportCapabilities = {
  h264: boolean;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  recommendedWidth: number;
  recommendedHeight: number;
  recommendedFps: number;
};

export type ExportProgress = {
  progress: number;
  status: "preparing" | "rendering" | "finalizing" | "complete" | "failed" | "cancelled";
};

export type NativeExportRequest = {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  sourceWidth: number;
  sourceHeight: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  outWidth: number;
  outHeight: number;
  volume: number;
  muted: boolean;
  watermark: boolean;
  watermarkPath: string | null;
};

type NativeModule = {
  getExportCapabilities: () => Promise<ExportCapabilities>;
  exportProject: (request: NativeExportRequest) => Promise<{ path: string; durationMs: number }>;
  cancelExport: () => void;
  addListener: (event: string, listener: (event: ExportProgress) => void) => { remove(): void };
};

let native: NativeModule | null | undefined;

function moduleOrNull(): NativeModule | null {
  if (native !== undefined) return native;
  try {
    native = requireNativeModule<NativeModule>("ReplayrExport");
  } catch {
    native = null;
  }
  return native;
}

export function exportAvailable(): boolean {
  return moduleOrNull() != null;
}

export async function getExportCapabilities(): Promise<ExportCapabilities> {
  const current = moduleOrNull();
  if (!current) throw new Error("Export needs a Replayr development build.");
  return current.getExportCapabilities();
}

export async function exportProject(request: NativeExportRequest): Promise<{ path: string; durationMs: number }> {
  const current = moduleOrNull();
  if (!current) throw new Error("Export needs a Replayr development build.");
  return current.exportProject(request);
}

export function cancelExport(): void {
  moduleOrNull()?.cancelExport();
}

export function addExportProgressListener(listener: (event: ExportProgress) => void) {
  const current = moduleOrNull();
  if (!current) return { remove() {} };
  return current.addListener("onExportProgress", listener);
}

/** Reads normalized 0–1 peaks from a local file path or file:// URI. Returns null when unavailable. */
export async function readAudioPeaks(localPath: string, buckets = 140): Promise<number[] | null> {
  const current = moduleOrNull() as
    | (NativeModule & { readAudioPeaks?: (source: string, count: number) => Promise<{ peaks?: number[] }> })
    | null;
  if (!current || typeof current.readAudioPeaks !== "function") return null;
  if (/^https?:\/\//i.test(localPath)) return null;
  try {
    const result = await current.readAudioPeaks(localPath, buckets);
    const peaks = Array.isArray(result?.peaks) ? result.peaks : [];
    if (peaks.length === 0) return null;
    return peaks.map((value) => {
      const next = Number(value);
      if (!Number.isFinite(next)) return 0;
      return Math.max(0, Math.min(1, next));
    });
  } catch {
    return null;
  }
}
