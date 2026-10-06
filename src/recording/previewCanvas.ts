/** Presentation-only output size. Never written into a scene or recording settings. */

export type PreviewCanvasSize = {
  width: number;
  height: number;
  /** True until a composed session reports the negotiated size. */
  provisional: boolean;
};

export type PreviewStatusFields = {
  live: boolean;
  label: string;
  source: string;
  width: number;
  height: number;
};

export function resolutionCap(resolution: string): { width: number; height: number } | null {
  switch (resolution) {
    case "720p":
      return { width: 1280, height: 720 };
    case "1080p":
      return { width: 1920, height: 1080 };
    case "1440p":
      return { width: 2560, height: 1440 };
    case "4k":
      return { width: 3840, height: 2160 };
    case "native":
      return null;
    default:
      return { width: 1920, height: 1080 };
  }
}

export function evenSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  return { width: w - (w % 2), height: h - (h % 2) };
}

/** Same rule as the composed recorder: fit inside a box without stretching. */
export function fitInsidePreservingAspect(
  sourceW: number,
  sourceH: number,
  capW: number,
  capH: number,
): { width: number; height: number } {
  const sw = Math.max(1, sourceW);
  const sh = Math.max(1, sourceH);
  if (sw <= capW && sh <= capH) return evenSize(sw, sh);
  const scale = Math.min(capW / sw, capH / sh);
  return evenSize(sw * scale, sh * scale);
}

export function canvasFromAspect(aspect: number, resolution: string): PreviewCanvasSize {
  const safe = aspect > 0 ? aspect : 16 / 9;
  const cap = resolutionCap(resolution);
  if (!cap) {
    const height = 1080;
    return { ...evenSize(height * safe, height), provisional: true };
  }
  const fitted = fitInsidePreservingAspect(safe * 10000, 10000, cap.width, cap.height);
  return { ...fitted, provisional: true };
}

export function previewCanvasSize(input: {
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  resolution: string;
}): PreviewCanvasSize {
  const outputW = input.outputWidth ?? 0;
  const outputH = input.outputHeight ?? 0;
  if (outputW >= 2 && outputH >= 2) {
    return { width: outputW, height: outputH, provisional: false };
  }
  const sourceW = input.sourceWidth ?? 0;
  const sourceH = input.sourceHeight ?? 0;
  const cap = resolutionCap(input.resolution);
  if (sourceW >= 2 && sourceH >= 2) {
    if (!cap) return { ...evenSize(sourceW, sourceH), provisional: true };
    const fitted = fitInsidePreservingAspect(sourceW, sourceH, cap.width, cap.height);
    return { ...fitted, provisional: true };
  }
  const fallback = cap ?? { width: 1920, height: 1080 };
  return { width: fallback.width, height: fallback.height, provisional: true };
}

export function containOnCanvas(sourceAspect: number, canvasAspect: number): { x: number; y: number; w: number; h: number } {
  const source = sourceAspect > 0 ? sourceAspect : 1;
  const canvas = canvasAspect > 0 ? canvasAspect : 1;
  if (source >= canvas) {
    const h = canvas / source;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = source / canvas;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

export function croppedSourceAspect(sourceAspect: number, cropW: number, cropH: number): number {
  if (cropH <= 0) return sourceAspect;
  return (sourceAspect * cropW) / cropH;
}

export function samePreviewStatus(prev: PreviewStatusFields, next: PreviewStatusFields): boolean {
  return (
    prev.live === next.live &&
    prev.label === next.label &&
    prev.source === next.source &&
    prev.width === next.width &&
    prev.height === next.height
  );
}

export type GestureFinish = "commit" | "cancel" | "ignore";

/** Completed drags persist. Cancels restore. A scene change must not receive the gesture. */
export function gestureFinish(
  kind: "up" | "cancel" | "unmount",
  gestureSceneId: string,
  activeSceneId: string,
): GestureFinish {
  if (gestureSceneId !== activeSceneId) return "ignore";
  if (kind === "cancel") return "cancel";
  return "commit";
}
