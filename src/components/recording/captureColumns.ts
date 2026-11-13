/** Pixel widths for the Capture dock columns that resize by dragging. */

export const CAPTURE_COLUMN_WIDTHS_KEY = "replay.captureColumnWidths";

export const CAPTURE_RESIZE_COLUMNS = ["scenes", "sources", "mixer", "controls"] as const;
export type CaptureResizeColumn = (typeof CAPTURE_RESIZE_COLUMNS)[number];

const LIMITS: Record<CaptureResizeColumn, { min: number; max: number; fallback: number }> = {
  scenes: { min: 168, max: 480, fallback: 220 },
  sources: { min: 220, max: 720, fallback: 300 },
  mixer: { min: 240, max: 760, fallback: 320 },
  controls: { min: 260, max: 640, fallback: 340 },
};

export function isCaptureResizeColumn(id: string): id is CaptureResizeColumn {
  return (CAPTURE_RESIZE_COLUMNS as readonly string[]).includes(id);
}

export function clampCaptureColumnWidth(id: CaptureResizeColumn, value: number): number {
  const limit = LIMITS[id];
  if (!Number.isFinite(value)) return limit.fallback;
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)));
}

export function captureColumnMin(id: CaptureResizeColumn): number {
  return LIMITS[id].min;
}

export function defaultCaptureColumnWidths(): Record<CaptureResizeColumn, number> {
  return {
    scenes: LIMITS.scenes.fallback,
    sources: LIMITS.sources.fallback,
    mixer: LIMITS.mixer.fallback,
    controls: LIMITS.controls.fallback,
  };
}

export function readCaptureColumnWidths(): Record<CaptureResizeColumn, number> {
  const fallback = defaultCaptureColumnWidths();
  try {
    const raw = JSON.parse(window.localStorage.getItem(CAPTURE_COLUMN_WIDTHS_KEY) || "null") as unknown;
    if (!raw || typeof raw !== "object") return fallback;
    const record = raw as Record<string, unknown>;
    return {
      scenes: clampCaptureColumnWidth("scenes", Number(record.scenes)),
      sources: clampCaptureColumnWidth("sources", Number(record.sources)),
      mixer: clampCaptureColumnWidth("mixer", Number(record.mixer)),
      controls: clampCaptureColumnWidth("controls", Number(record.controls)),
    };
  } catch {
    return fallback;
  }
}

export function captureColumnResizeLabel(id: CaptureResizeColumn): string {
  if (id === "scenes") return "Resize scenes";
  if (id === "sources") return "Resize sources";
  if (id === "mixer") return "Resize audio mixer";
  return "Resize recording controls";
}
