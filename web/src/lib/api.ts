import { apiUrl } from "./supabase";

export interface PlaybackClip {
  slug: string;
  title: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  visibility: string;
  status: string;
  playbackUrl: string;
  thumbnailUrl?: string | null;
}

export interface ManagedClip {
  id: string;
  title: string | null;
  slug: string;
  status: string;
  visibility: "public" | "unlisted" | "private";
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
}

export interface LibraryPage {
  clips: ManagedClip[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchLibrary(
  accessToken: string,
  options?: { page?: number; limit?: number },
): Promise<LibraryPage> {
  const page = options?.page ?? 1;
  const limit = options?.limit ?? 24;
  const response = await fetch(apiUrl(`/v1/library?page=${page}&limit=${limit}`), {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as LibraryPage & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Could not load cloud clips.");
  }
  return {
    clips: body.clips ?? [],
    total: Number(body.total) || 0,
    page: Number(body.page) || page,
    limit: Number(body.limit) || limit,
  };
}

export async function fetchPlayback(slug: string, accessToken?: string | null): Promise<PlaybackClip> {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl(`/v1/clips/${slug}`), { headers });
  const body = (await response.json()) as PlaybackClip & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || "That clip is not available.");
  }
  return body;
}

export async function downloadCloudClip(slug: string, title: string | null, accessToken?: string | null): Promise<void> {
  const headers: HeadersInit = { accept: "application/octet-stream, application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl(`/v1/clips/${slug}/download`), { headers });
  if (!response.ok) {
    let message = "Could not download that clip.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = suggestedDownloadName(title, slug);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function suggestedDownloadName(title: string | null, slug: string) {
  const base = (title || slug)
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "clip"}.mp4`;
}

export async function deleteCloudClip(clipId: string, accessToken: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/clips/${clipId}`), {
    method: "DELETE",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (response.ok) return;
  let message = "Could not delete that cloud clip.";
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* keep default */
  }
  throw new Error(message);
}
