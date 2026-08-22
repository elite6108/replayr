export function suggestedFileName(title: string | null | undefined, fallback: string, ext: string): string {
  const base = (title || fallback)
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || fallback}.${ext}`;
}
