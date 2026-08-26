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
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
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
  };
  return named[code] ?? null;
}
