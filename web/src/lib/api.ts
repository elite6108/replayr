import { readApiError, readApiJson } from "./http";
import { apiUrl } from "./supabase";

export interface ClipAuthor {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ClipComment {
  id: string;
  body: string;
  createdAt: string;
  mine: boolean;
  canDelete: boolean;
  author: ClipAuthor;
}

export interface PlaybackClip {
  id?: string;
  slug: string;
  title: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  visibility: string;
  status: string;
  playbackUrl: string;
  thumbnailUrl?: string | null;
  author?: ClipAuthor;
  likeCount?: number;
  commentCount?: number;
  liked?: boolean;
  watermark?: boolean;
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
  watermark?: boolean;
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
  const body = await readApiJson<LibraryPage>(response, "Could not load cloud clips.");
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
  return readApiJson<PlaybackClip>(response, "That clip is not available.");
}

export type DownloadProgress = {
  attempt: number;
  attempts: number;
  message: string;
  progress: number;
};

export async function downloadCloudClip(
  slug: string,
  title: string | null,
  accessToken?: string | null,
  onProgress?: (update: DownloadProgress) => void,
): Promise<void> {
  const headers: HeadersInit = { accept: "application/octet-stream, application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const url = apiUrl(`/v1/clips/${slug}/download`);
  const attempts = 36;
  let lastMessage = "Download will begin within about 30 seconds…";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    onProgress?.({
      attempt: attempt + 1,
      attempts,
      message: lastMessage,
      progress: Math.min(0.92, 0.15 + (attempt / Math.min(attempts, 8)) * 0.75),
    });
    const response = await fetch(url, { headers, redirect: "manual" });
    if (response.status === 202) {
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) lastMessage = body.message;
      } catch {
        /* ignore */
      }
      lastMessage =
        attempt < 6
          ? "Download will begin within about 30 seconds…"
          : "Still preparing your branded download…";
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (response.status === 409) {
      throw new Error(await readApiError(response, "Branded download is unavailable for this clip."));
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Could not download that clip.");
      const file = await fetch(location, { headers: { Referer: "https://www.replayr.tv/" } });
      if (!file.ok) throw new Error("Could not download that clip.");
      const blob = await file.blob();
      assertVideoBlob(blob);
      onProgress?.({ attempt: attempt + 1, attempts, message: "Starting download…", progress: 1 });
      triggerBlobDownload(blob, title, slug);
      return;
    }
    if (!response.ok) {
      throw new Error(await readApiError(response, "Could not download that clip."));
    }
    const blob = await response.blob();
    assertVideoBlob(blob);
    onProgress?.({ attempt: attempt + 1, attempts, message: "Starting download…", progress: 1 });
    triggerBlobDownload(blob, title, slug);
    return;
  }
  throw new Error(lastMessage);
}

async function assertVideoBlob(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 96).arrayBuffer());
  const prefix = new TextDecoder().decode(head).trimStart();
  const hasFtyp = [...head].some(
    (_, i) =>
      i + 4 <= head.length &&
      head[i] === 0x66 &&
      head[i + 1] === 0x74 &&
      head[i + 2] === 0x79 &&
      head[i + 3] === 0x70,
  );
  if (prefix.startsWith("<") || prefix.startsWith("{") || !hasFtyp) {
    throw new Error("Download did not return a video file. Try again in a moment.");
  }
}

function triggerBlobDownload(blob: Blob, title: string | null, slug: string) {
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

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

export async function setClipLiked(slug: string, liked: boolean, accessToken: string) {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/like`), {
    method: liked ? "POST" : "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{ liked?: boolean; likeCount?: number }>(response, "Could not update that like.");
  return { liked: Boolean(body.liked), likeCount: Number(body.likeCount) || 0 };
}

export async function fetchClipComments(slug: string, accessToken?: string | null): Promise<ClipComment[]> {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments`), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ comments?: ClipComment[] }>(response, "Could not load comments.");
  return body.comments ?? [];
}

export async function postClipComment(slug: string, text: string, accessToken: string) {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments`), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ body: text }),
  });
  const body = await readApiJson<{ comments?: ClipComment[]; commentCount?: number }>(
    response,
    "Could not post that comment.",
  );
  return { comments: body.comments ?? [], commentCount: Number(body.commentCount) || 0 };
}

export async function deleteClipComment(slug: string, commentId: string, accessToken: string) {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments/${commentId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{ commentCount?: number }>(response, "Could not delete that comment.");
  return { commentCount: Number(body.commentCount) || 0 };
}

export async function deleteAccount(accessToken: string): Promise<void> {
  const response = await fetch(apiUrl("/v1/account/delete"), {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (response.ok) return;
  throw new Error(await readApiError(response, "Could not delete this account."));
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
  throw new Error(await readApiError(response, "Could not delete that cloud clip."));
}
