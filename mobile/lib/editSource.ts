import * as FileSystem from "expo-file-system/legacy";

const HEADROOM_BYTES = 256 * 1024 * 1024;
const FALLBACK_SOURCE_BYTES = 512 * 1024 * 1024;

const inflight = new Map<string, Promise<string>>();

function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "clip";
}

export function cacheFile(name: string): string {
  if (!FileSystem.cacheDirectory) throw new Error("This device has no cache directory.");
  return `${FileSystem.cacheDirectory}${name}`;
}

export function localSourcePath(slug: string): string {
  return cacheFile(`edit-src-${safeSlug(slug)}.mp4`);
}

async function remoteBytes(url: string): Promise<number> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    const bytes = Number(head.headers.get("content-length") || 0);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

/** Source download plus an encoded copy of similar size must fit with headroom. */
export async function assertExportStorage(playbackUrl: string): Promise<void> {
  const bytes = await remoteBytes(playbackUrl);
  const needed = (bytes > 0 ? bytes * 2 : FALLBACK_SOURCE_BYTES) + HEADROOM_BYTES;
  const free = await FileSystem.getFreeDiskStorageAsync();
  if (free > 0 && free < needed) {
    throw new Error("Not enough storage to export this clip.");
  }
}

async function existingFile(path: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(path);
  return info.exists && "size" in info && (info.size ?? 0) > 0;
}

/**
 * Downloads the clip once per slug and reuses the cached copy for the
 * waveform and the export. Concurrent callers share one download.
 */
export function ensureLocalSource(slug: string, playbackUrl: string): Promise<string> {
  const path = localSourcePath(slug);
  const pending = inflight.get(path);
  if (pending) return pending;
  const task = (async () => {
    if (await existingFile(path)) return path;
    await assertExportStorage(playbackUrl);
    const downloaded = await FileSystem.downloadAsync(playbackUrl, path);
    if (downloaded.status < 200 || downloaded.status >= 300 || !(await existingFile(path))) {
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
      throw new Error("Could not prepare the clip.");
    }
    return path;
  })().finally(() => {
    inflight.delete(path);
  });
  inflight.set(path, task);
  return task;
}

export async function removeLocalSource(slug: string): Promise<void> {
  await FileSystem.deleteAsync(localSourcePath(slug), { idempotent: true }).catch(() => undefined);
}
