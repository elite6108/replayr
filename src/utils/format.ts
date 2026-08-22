export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "R";
  const second = parts[1];
  if (second) {
    return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
  }
  return first.slice(0, 2).toUpperCase() || "R";
}

export function displayHotkey(combo: string): string {
  return combo
    .replaceAll("CommandOrControl", "Ctrl")
    .replaceAll("Control", "Ctrl")
    .replaceAll("+", " + ");
}

export function invokeErrorMessage(caught: unknown, fallback: string): string {
  if (typeof caught === "string" && caught.trim()) {
    return caught;
  }
  if (caught instanceof Error && caught.message.trim()) {
    return caught.message;
  }
  if (caught && typeof caught === "object") {
    const record = caught as { message?: unknown; error?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error;
    }
  }
  return fallback;
}

export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function isVideoPath(path: string): boolean {
  return /\.(mp4|webm|mov|mkv)$/i.test(path);
}
