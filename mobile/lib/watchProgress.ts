import * as FileSystem from "expo-file-system/legacy";

export interface WatchItem {
  slug: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  progress: number;
  updatedAt: number;
}

const FILE = "watch-progress.json";
let memory: WatchItem[] = [];
let loaded = false;

function fileUri() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${FILE}` : null;
}

async function load(): Promise<WatchItem[]> {
  if (loaded) return memory;
  loaded = true;
  const uri = fileUri();
  if (!uri) return memory;
  try {
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as WatchItem[];
    memory = Array.isArray(parsed) ? parsed.filter((item) => item?.slug).slice(0, 12) : [];
  } catch {
    memory = [];
  }
  return memory;
}

async function persist(items: WatchItem[]) {
  memory = items.slice(0, 12);
  const uri = fileUri();
  if (!uri) return;
  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(memory));
  } catch {
    /* keep memory copy */
  }
}

export async function listContinueWatching(): Promise<WatchItem[]> {
  const items = await load();
  return items
    .filter((item) => item.progress >= 0.04 && item.progress < 0.96)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
}

export async function saveWatchProgress(item: WatchItem): Promise<void> {
  const items = await load();
  const next = [item, ...items.filter((row) => row.slug !== item.slug)];
  await persist(next);
}
