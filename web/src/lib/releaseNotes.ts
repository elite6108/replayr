export interface ReleaseNoteEntry {
  version: string;
  items: string[];
}

function parseItems(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function formatReleaseNotes(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export async function fetchReleaseNotes(): Promise<ReleaseNoteEntry[]> {
  const response = await fetch("/releases/release-notes.json");
  if (!response.ok) return [];
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") return [];
  return Object.entries(body as Record<string, unknown>)
    .map(([version, items]) => ({ version, items: parseItems(items) }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export async function fetchLatestReleaseNote(): Promise<ReleaseNoteEntry | null> {
  const notes = await fetchReleaseNotes();
  return notes[0] ?? null;
}
