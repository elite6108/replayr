export function planLabel(slug: string): string {
  if (slug === "pro_plus") return "Pro+";
  if (slug === "pro") return "Pro";
  if (slug === "free") return "Free";
  return slug;
}

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

export function parseClipDate(value: string | number | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const sqlite = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (sqlite) {
    const iso = `${sqlite[1]}T${sqlite[2]}${sqlite[3] || ""}${sqlite[4] || "Z"}`;
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatClipDate(value: string | number | null | undefined): string {
  const date = parseClipDate(value);
  if (!date) {
    const raw = value == null ? "" : String(value).trim();
    return raw.slice(0, 10);
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / dayMs);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (deltaDays === 0) return `Today · ${time}`;
  if (deltaDays === 1) return `Yesterday · ${time}`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
