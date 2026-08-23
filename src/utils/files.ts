export function suggestedFileName(title: string | null | undefined, fallback: string, ext: string): string {
  const base = (title || fallback)
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || fallback}.${ext}`;
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${file}`;
}

export function uniqueFileName(used: Set<string>, name: string): string {
  const key = name.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  let next = `${base} (${index})${ext}`;
  while (used.has(next.toLowerCase())) {
    index += 1;
    next = `${base} (${index})${ext}`;
  }
  used.add(next.toLowerCase());
  return next;
}
