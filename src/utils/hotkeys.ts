export const HOTKEY_ACTIONS = [
  "saveReplay",
  "toggleRecording",
  "regionScreenshot",
  "screenshot",
] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  saveReplay: "CommandOrControl+F10",
  toggleRecording: "CommandOrControl+F9",
  regionScreenshot: "CommandOrControl+PrintScreen",
  screenshot: "CommandOrControl+F11",
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  saveReplay: "Save Replay",
  toggleRecording: "Start/Stop Recording",
  regionScreenshot: "Take Screenshot",
  // Saves the last Instant Replay frame. Labelled apart from the drag-to-select screenshot so the
  // two are not confused in Settings.
  screenshot: "Save Replay Frame",
};

/** Hand-mirrored with `HotkeyFailure` in src-tauri/src/hotkeys.rs. */
export interface HotkeyFailure {
  action: "save_replay" | "toggle_recording" | "screenshot" | "region_screenshot";
  combo: string;
  reason:
    | { kind: "invalid"; detail: string }
    | { kind: "duplicate"; detail: string }
    | { kind: "inUse"; detail: string };
}

const RUST_ACTION: Record<HotkeyAction, HotkeyFailure["action"]> = {
  saveReplay: "save_replay",
  toggleRecording: "toggle_recording",
  regionScreenshot: "region_screenshot",
  screenshot: "screenshot",
};

/** The registration failure for one action, if the OS refused it. */
export function failureFor(failures: HotkeyFailure[], action: HotkeyAction): HotkeyFailure | undefined {
  return failures.find((failure) => failure.action === RUST_ACTION[action]);
}

export function describeHotkeyFailure(failure: HotkeyFailure): string {
  switch (failure.reason.kind) {
    case "inUse":
      return "In use by another app. Pick a different shortcut.";
    case "duplicate":
      return "Already used by another Replayr shortcut.";
    default:
      return "Not a valid shortcut.";
  }
}

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

/** Map a browser key event to a Tauri global-shortcut string, or null if incomplete. */
export function comboFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.repeat) return null;
  if (event.key === "Escape" || event.key === "Dead") return null;
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;

  const key = keyToken(event);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function keyToken(event: KeyboardEvent): string | null {
  const { code, key } = event;
  // F13–F24 exist on macro keyboards and are ideal conflict-free bindings.
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad${code.slice(6)}`;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (code.startsWith("Arrow")) return code;
  const named: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backquote: "Backquote",
    PrintScreen: "PrintScreen",
    ScrollLock: "ScrollLock",
    Pause: "Pause",
  };
  return named[code] ?? null;
}

/**
 * Keys Chromium on Windows reports only on keyup — Windows consumes the keydown for its own
 * screenshot handling — so the recorder has to listen for their release.
 */
export function isKeyupOnlyKey(event: KeyboardEvent): boolean {
  return event.code === "PrintScreen";
}
