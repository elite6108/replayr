export type StudioMode = "recording" | "clip";

export const RECORD_STUDIO_TAB_KEY = "replay.recordStudioTab";

export function parseStudioMode(value: unknown): StudioMode {
  return value === "clip" ? "clip" : "recording";
}

export function loadStudioMode(): StudioMode {
  try {
    return parseStudioMode(localStorage.getItem(RECORD_STUDIO_TAB_KEY));
  } catch {
    return "recording";
  }
}

export function persistStudioMode(mode: StudioMode): void {
  try {
    localStorage.setItem(RECORD_STUDIO_TAB_KEY, mode);
  } catch {
    /* private mode */
  }
}
