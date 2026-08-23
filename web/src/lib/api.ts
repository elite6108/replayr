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
  const body = (await response.json()) as { liked?: boolean; likeCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not update that like.");
  return { liked: Boolean(body.liked), likeCount: Number(body.likeCount) || 0 };
}

export async function fetchClipComments(slug: string, accessToken?: string | null): Promise<ClipComment[]> {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments`), { headers: authHeaders(accessToken) });
  const body = (await response.json()) as { comments?: ClipComment[]; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load comments.");
  return body.comments ?? [];
}

export async function postClipComment(slug: string, text: string, accessToken: string) {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments`), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ body: text }),
  });
  const body = (await response.json()) as { comments?: ClipComment[]; commentCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not post that comment.");
  return { comments: body.comments ?? [], commentCount: Number(body.commentCount) || 0 };
}

export async function deleteClipComment(slug: string, commentId: string, accessToken: string) {
  const response = await fetch(apiUrl(`/v1/clips/${slug}/comments/${commentId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = (await response.json()) as { commentCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not delete that comment.");
  return { commentCount: Number(body.commentCount) || 0 };
}

export async function deleteAccount(accessToken: string): Promise<void> {
  const response = await fetch(apiUrl("/v1/account/delete"), {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (response.ok) return;
  let message = "Could not delete this account.";
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* keep default */
  }
  throw new Error(message);
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
