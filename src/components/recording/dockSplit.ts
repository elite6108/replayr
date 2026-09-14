/** Preview/dock splitter geometry, shared by both Record studios. Moved verbatim. */

const DOCK_SPLIT_KEY = "replay.recordDockMaxPx";
export const DOCK_MIN_PX = 160;
export const DOCK_DEFAULT_PX = 200;
export const PREVIEW_MIN_PX = 320;

export function clampDockPx(value: number, workspaceHeight = 0) {
  const maxByWindow = Math.round(window.innerHeight * 0.28);
  const maxByWorkspace =
    workspaceHeight > PREVIEW_MIN_PX + DOCK_MIN_PX
      ? workspaceHeight - PREVIEW_MIN_PX
      : maxByWindow;
  return Math.min(Math.max(Math.round(value), DOCK_MIN_PX), Math.min(maxByWindow, maxByWorkspace));
}

export function dockPxFromPointer(workspace: HTMLElement, clientY: number) {
  const rect = workspace.getBoundingClientRect();
  const status = workspace.querySelector(".studio-status");
  const statusH = status instanceof HTMLElement ? status.getBoundingClientRect().height : 0;
  return clampDockPx(rect.bottom - statusH - 10 - clientY, rect.height);
}

export function loadDockMaxPx(): number {
  try {
    const raw = localStorage.getItem(DOCK_SPLIT_KEY);
    const value = raw == null ? DOCK_DEFAULT_PX : Number(raw);
    if (!Number.isFinite(value)) return DOCK_DEFAULT_PX;
    return clampDockPx(value);
  } catch {
    return DOCK_DEFAULT_PX;
  }
}

export function persistDockMaxPx(value: number) {
  try {
    localStorage.setItem(DOCK_SPLIT_KEY, String(Math.round(value)));
  } catch {
    /* private mode */
  }
}
