/** The same address rules the recorder enforces. A page stays on https, or http on this computer. */

const MAX_URL = 2048;

export function sanitizePageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL) return null;
  if (/[\u0000-\u0020\\]/.test(trimmed)) return null;
  const split = trimmed.indexOf("://");
  if (split <= 0) return null;
  const scheme = trimmed.slice(0, split).toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  const rest = trimmed.slice(split + 3);
  if (!rest || rest.startsWith("/") || rest.includes("@")) return null;
  const end = rest.search(/[/?#]/);
  const authority = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
  const path = end === -1 ? "/" : rest.slice(end);
  if (!authority || authority.includes("*") || path.startsWith("//")) return null;
  const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0] ?? "";
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (scheme === "http" && !local) return null;
  if (!host) return null;
  return `${scheme}://${authority}${path}`;
}
