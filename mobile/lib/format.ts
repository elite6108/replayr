export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function formatCount(value: number | null | undefined): string {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const thousands = n / 1000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const millions = n / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatHandle(author?: { username?: string | null; displayName?: string | null } | null): string {
  if (author?.username) return `@${author.username}`;
  return author?.displayName || "Player";
}

export function formatDurationMs(ms: number | null | undefined): string {
  return formatClockSeconds((ms ?? 0) / 1000);
}

export function formatClockSeconds(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatSectionLabel(value: string | null | undefined): string {
  if (!value) return "Clips";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Clips";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function formatClipDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
