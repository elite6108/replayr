import * as FileSystem from "expo-file-system/legacy";
import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

type UploadStart = {
  clipId: string;
  slug: string;
  uploadId: string | null;
  parts: { partNumber: number; url: string }[];
};

export async function cloudFileBytes(url: string): Promise<number> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    const size = Number(head.headers.get("content-length") || 0);
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

export async function localFileBytes(path: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists || !("size" in info) || !info.size) {
    throw new Error("Exported file is missing.");
  }
  return info.size;
}

export function cloudCopyFits(used: number, limit: number, exportSize: number): boolean {
  return used + exportSize <= limit;
}

export function replaceCopyFits(used: number, limit: number, currentSize: number, exportSize: number): boolean {
  return used - Math.max(0, currentSize) + exportSize <= limit;
}

export async function uploadEditedClip(options: {
  accessToken: string;
  filePath: string;
  size: number;
  title: string | null;
  durationMs: number;
  width: number;
  height: number;
  replacesClipId?: string | null;
}): Promise<{ slug: string; clipId: string }> {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${options.accessToken}`,
  };
  const started = await fetch(apiUrl("/v1/clips/uploads"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      size: options.size,
      contentType: "video/mp4",
      durationMs: Math.round(options.durationMs),
      width: Math.round(options.width),
      height: Math.round(options.height),
      title: options.title,
      preferSinglePut: true,
      ...(options.replacesClipId ? { replacesClipId: options.replacesClipId } : {}),
    }),
  });
  const start = await readApiJson<UploadStart>(started, "Could not start the cloud upload.");
  const part = start.parts?.[0];
  if (!start.clipId || !part?.url || start.uploadId || start.parts.length !== 1) {
    throw new Error("Could not start the cloud upload.");
  }
  const uploaded = await FileSystem.uploadAsync(part.url, options.filePath, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "content-type": "video/mp4" },
  });
  if (uploaded.status < 200 || uploaded.status >= 300) {
    throw new Error("Could not upload the clip.");
  }
  const finished = await fetch(apiUrl(`/v1/clips/${start.clipId}/complete`), {
    method: "POST",
    headers,
    body: JSON.stringify({
      durationMs: Math.round(options.durationMs),
      width: Math.round(options.width),
      height: Math.round(options.height),
    }),
  });
  const done = await readApiJson<{ slug: string; clipId: string }>(finished, "Could not finish the cloud upload.");
  return { slug: done.slug || start.slug, clipId: done.clipId || start.clipId };
}
