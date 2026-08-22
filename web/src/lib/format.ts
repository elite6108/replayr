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

export function formatDurationMs(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatClipCap(ms: number | null | undefined): string {
  if (ms == null) return "No cap";
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} min`;
}

export function planLabel(slug: string): string {
  if (slug === "pro_plus") return "Pro+";
  if (slug === "pro") return "Pro";
  if (slug === "free") return "Free";
  return slug;
}
