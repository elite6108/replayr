export const HOTKEY_ACTIONS = [
  "saveReplay",
  "toggleRecording",
  "screenshot",
] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  saveReplay: "CommandOrControl+F10",
  toggleRecording: "CommandOrControl+F9",
  screenshot: "CommandOrControl+F11",
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  saveReplay: "Save Replay",
  toggleRecording: "Start/Stop Recording",
  screenshot: "Screenshot",
};

export function findHotkeyConflicts(
  bindings: Record<HotkeyAction, string>,
): Partial<Record<HotkeyAction, HotkeyAction>> {
  const used = new Map<string, HotkeyAction>();
  const conflicts: Partial<Record<HotkeyAction, HotkeyAction>> = {};

  for (const action of HOTKEY_ACTIONS) {
    const combo = bindings[action].trim().toLowerCase();
    if (!combo) continue;
    const existing = used.get(combo);
    if (existing) {
      conflicts[action] = existing;
    } else {
      used.set(combo, action);
    }
  }

  return conflicts;
}
