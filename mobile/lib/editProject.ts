/**
 * Mobile edit project. Segment timing uses the desktop editor's segment model
 * so a trim means the same thing on both apps. This version stores one cloud
 * clip, one trim, frame crop, and mixed-audio volume. It does not replace the
 * cloud master.
 */
import { outerRange, setOuterRange, singleSegment, type Segment } from "../../src/components/editor/segments.ts";

export const MIN_TRIM_MS = 1000;
export const PROJECT_VERSION = 1;

export type FrameAspect = "original" | "16:9" | "9:16";

export type EditProject = {
  version: typeof PROJECT_VERSION;
  source: {
    kind: "cloud";
    clipId: string;
    slug: string;
    durationMs: number;
    width: number;
    height: number;
  };
  segments: Segment[];
  frame: { aspect: FrameAspect; pan: number };
  audio: { volume: number; muted: boolean };
};

export type ExportRequest = {
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

const ASPECTS: FrameAspect[] = ["original", "16:9", "9:16"];

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded - (rounded % 2);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function createEditProject(clip: {
  id: string;
  slug: string;
  durationMs: number;
  width: number;
  height: number;
}): EditProject {
  const durationMs = Math.max(MIN_TRIM_MS, Math.round(clip.durationMs));
  const width = Math.max(2, Math.round(clip.width));
  const height = Math.max(2, Math.round(clip.height));
  return {
    version: PROJECT_VERSION,
    source: { kind: "cloud", clipId: clip.id, slug: clip.slug, durationMs, width, height },
    segments: singleSegment(0, durationMs),
    frame: { aspect: "original", pan: 0.5 },
    audio: { volume: 1, muted: false },
  };
}

export function applyTrim(project: EditProject, startMs: number, endMs: number): EditProject {
  const duration = project.source.durationMs;
  let start = Math.max(0, Math.min(duration, Math.round(startMs)));
  let end = Math.max(0, Math.min(duration, Math.round(endMs)));
  if (end < start) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (end - start < MIN_TRIM_MS) {
    if (start + MIN_TRIM_MS <= duration) end = start + MIN_TRIM_MS;
    else start = Math.max(0, duration - MIN_TRIM_MS);
    end = Math.min(duration, start + Math.max(MIN_TRIM_MS, end - start));
  }
  return {
    ...project,
    segments: setOuterRange(project.segments, start, end, MIN_TRIM_MS, duration),
  };
}

export function projectRange(project: EditProject): { startMs: number; endMs: number } {
  return outerRange(project.segments);
}

function snapOffset(value: number, room: number): number {
  const max = Math.max(0, room);
  let next = Math.round(Math.max(0, Math.min(max, value)));
  if (next % 2) next -= 1;
  return Math.max(0, Math.min(max, next));
}

/**
 * Crop window in source pixels. 16:9 and 9:16 render at 1080p.
 * Original fits inside 1920×1080 and is not scaled up.
 */
export function outputFrame(project: EditProject): {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  outWidth: number;
  outHeight: number;
} {
  const srcW = even(project.source.width);
  const srcH = even(project.source.height);
  const pan = clamp01(project.frame.pan);
  const target =
    project.frame.aspect === "9:16" ? 9 / 16 : project.frame.aspect === "16:9" ? 16 / 9 : srcW / Math.max(1, srcH);
  let cropW = srcW;
  let cropH = srcH;
  if (srcW / srcH > target + 0.001) cropW = even(Math.min(srcW, srcH * target));
  else if (srcW / srcH < target - 0.001) cropH = even(Math.min(srcH, srcW / target));
  const xRoom = srcW - cropW;
  const yRoom = srcH - cropH;
  const cropX = snapOffset(xRoom > 0 ? xRoom * pan : 0, xRoom);
  const cropY = snapOffset(yRoom > 0 ? yRoom * pan : 0, yRoom);
  if (project.frame.aspect === "9:16") {
    return { cropX, cropY, cropWidth: cropW, cropHeight: cropH, outWidth: 1080, outHeight: 1920 };
  }
  if (project.frame.aspect === "16:9") {
    return { cropX, cropY, cropWidth: cropW, cropHeight: cropH, outWidth: 1920, outHeight: 1080 };
  }
  const fit = Math.min(1, 1920 / srcW, 1080 / srcH);
  return {
    cropX: 0,
    cropY: 0,
    cropWidth: srcW,
    cropHeight: srcH,
    outWidth: even(srcW * fit),
    outHeight: even(srcH * fit),
  };
}

export function buildExportRequest(
  project: EditProject,
  sourcePath: string,
  outputPath: string,
  watermark: boolean,
  watermarkPath: string | null,
): ExportRequest {
  if (project.segments.length !== 1) {
    throw new Error("This version exports one trim.");
  }
  if (watermark && !watermarkPath) {
    throw new Error("Could not load the Replayr watermark.");
  }
  const range = projectRange(project);
  if (range.endMs - range.startMs < MIN_TRIM_MS) {
    throw new Error("Select at least one second.");
  }
  const frame = outputFrame(project);
  return {
    sourcePath,
    outputPath,
    startMs: range.startMs,
    endMs: range.endMs,
    sourceWidth: even(project.source.width),
    sourceHeight: even(project.source.height),
    ...frame,
    volume: project.audio.muted ? 0 : clamp01(project.audio.volume),
    muted: project.audio.muted || project.audio.volume <= 0,
    watermark,
    watermarkPath: watermark ? watermarkPath : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function parseEditProject(raw: unknown, clipId: string): EditProject | null {
  if (!isRecord(raw) || raw.version !== PROJECT_VERSION) return null;
  const source = raw.source;
  const frame = raw.frame;
  const audio = raw.audio;
  if (!isRecord(source) || source.kind !== "cloud" || source.clipId !== clipId) return null;
  if (typeof source.slug !== "string" || typeof source.durationMs !== "number") return null;
  if (typeof source.width !== "number" || typeof source.height !== "number") return null;
  if (!Array.isArray(raw.segments) || raw.segments.length !== 1) return null;
  const segment = raw.segments[0];
  if (!isRecord(segment) || typeof segment.startMs !== "number" || typeof segment.endMs !== "number") return null;
  if (!isRecord(frame) || !ASPECTS.includes(frame.aspect as FrameAspect)) return null;
  if (!isRecord(audio) || typeof audio.volume !== "number" || typeof audio.muted !== "boolean") return null;
  const base = createEditProject({
    id: clipId,
    slug: source.slug,
    durationMs: source.durationMs,
    width: source.width,
    height: source.height,
  });
  const id = typeof segment.id === "string" ? segment.id : base.segments[0]!.id;
  return applyTrim(
    {
      ...base,
      segments: [{ id, startMs: segment.startMs, endMs: segment.endMs }],
      frame: { aspect: frame.aspect as FrameAspect, pan: clamp01(Number(frame.pan)) },
      audio: { volume: clamp01(audio.volume), muted: audio.muted },
    },
    segment.startMs,
    segment.endMs,
  );
}
