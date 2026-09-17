export function formatRelativeTime(value: string | number | null | undefined): string {
  if (value == null || value === "") return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const delta = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "Just now";
  if (delta < hour) {
    const minutes = Math.floor(delta / minute);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (delta < day) {
    const hours = Math.floor(delta / hour);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (delta < 7 * day) {
    const days = Math.floor(delta / day);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function initials(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "R";
  const parts = text.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return text.slice(0, 2).toUpperCase();
}
