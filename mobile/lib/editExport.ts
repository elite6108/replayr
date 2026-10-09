import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import {
  addExportProgressListener,
  cancelExport,
  exportProject,
  type ExportProgress,
} from "replayr-export";
import { buildExportRequest, type EditProject } from "./editProject";
import { writeExportJob, type ExportJobRecord } from "./editProjectStore";

const WATERMARK = require("../assets/images/replayr-watermark.png");

function cacheFile(name: string) {
  if (!FileSystem.cacheDirectory) throw new Error("This device has no cache directory.");
  return `${FileSystem.cacheDirectory}${name}`;
}

async function watermarkFile(): Promise<string> {
  const asset = Asset.fromModule(WATERMARK);
  if (!asset.localUri) await asset.downloadAsync();
  if (!asset.localUri) throw new Error("Could not load the Replayr watermark.");
  return asset.localUri;
}

async function assertStorage(playbackUrl: string) {
  let bytes = 0;
  try {
    const head = await fetch(playbackUrl, { method: "HEAD" });
    bytes = Number(head.headers.get("content-length") || 0);
  } catch {
    bytes = 0;
  }
  const needed = (Number.isFinite(bytes) && bytes > 0 ? bytes * 2 : 512 * 1024 * 1024) + 256 * 1024 * 1024;
  const free = await FileSystem.getFreeDiskStorageAsync();
  if (free > 0 && free < needed) {
    throw new Error("Not enough storage to export this clip.");
  }
}

export async function renderEdit(options: {
  project: EditProject;
  playbackUrl: string;
  watermark: boolean;
  onProgress: (event: Pick<ExportProgress, "status" | "progress">) => void;
}): Promise<{ path: string; durationMs: number }> {
  const { project, playbackUrl, watermark, onProgress } = options;
  const jobId = `export-${Date.now()}`;
  const slug = project.source.slug.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "clip";
  const sourcePath = cacheFile(`edit-src-${slug}.mp4`);
  const outputPath = cacheFile(`edit-out-${slug}-${Date.now()}.mp4`);
  const write = (patch: Partial<ExportJobRecord> & Pick<ExportJobRecord, "status" | "progress">) =>
    writeExportJob({
      id: jobId,
      slug: project.source.slug,
      outputPath: patch.outputPath ?? null,
      errorMessage: patch.errorMessage ?? null,
      updatedAt: Date.now(),
      status: patch.status,
      progress: patch.progress,
    });

  let subscription: { remove(): void } | null = null;
  try {
    onProgress({ status: "preparing", progress: 0 });
    await write({ status: "preparing", progress: 0 });
    const watermarkPath = watermark ? await watermarkFile() : null;
    const request = buildExportRequest(project, sourcePath, outputPath, watermark, watermarkPath);
    await assertStorage(playbackUrl);
    const downloaded = await FileSystem.downloadAsync(playbackUrl, sourcePath);
    if (downloaded.status < 200 || downloaded.status >= 300) {
      throw new Error("Could not prepare the clip.");
    }
    subscription = addExportProgressListener((event) => {
      onProgress(event);
      void write({ status: "rendering", progress: event.progress, outputPath });
    });
    onProgress({ status: "rendering", progress: 0 });
    await write({ status: "rendering", progress: 0, outputPath });
    const result = await exportProject(request);
    await write({ status: "complete", progress: 1, outputPath: result.path });
    onProgress({ status: "complete", progress: 1 });
    return result;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Export failed.";
    const cancelled = /cancel/i.test(message);
    await write({
      status: cancelled ? "cancelled" : "failed",
      progress: 0,
      errorMessage: message,
    });
    throw caught;
  } finally {
    subscription?.remove();
    await FileSystem.deleteAsync(sourcePath, { idempotent: true }).catch(() => undefined);
  }
}

export function cancelRender() {
  cancelExport();
}
