import { Asset } from "expo-asset";
import {
  addExportProgressListener,
  cancelExport,
  exportProject,
  type ExportProgress,
} from "replayr-export";
import { buildExportRequest, type EditProject } from "./editProject";
import { writeExportJob, type ExportJobRecord } from "./editProjectStore";
import { cacheFile, ensureLocalSource } from "./editSource";

const WATERMARK = require("../assets/images/replayr-watermark.png");

async function watermarkFile(): Promise<string> {
  const asset = Asset.fromModule(WATERMARK);
  if (!asset.localUri) await asset.downloadAsync();
  if (!asset.localUri) throw new Error("Could not load the Replayr watermark.");
  return asset.localUri;
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
    const sourcePath = await ensureLocalSource(project.source.slug, playbackUrl);
    const request = buildExportRequest(project, sourcePath, outputPath, watermark, watermarkPath);
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
  }
}

export function cancelRender() {
  cancelExport();
}
