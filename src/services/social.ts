import { publicApiUrl } from "../branding";

export interface ClipAuthor {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PublicFeedClip {
  id: string;
  title: string | null;
  slug: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  game: { name: string; slug: string; coverUrl: string | null } | null;
  author: ClipAuthor;
  likeCount: number;
  commentCount: number;
  liked: boolean;
}

export interface ClipComment {
  id: string;
  body: string;
  createdAt: string;
  mine: boolean;
  canDelete: boolean;
  author: ClipAuthor;
}

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

function normalize(clip: PublicFeedClip): PublicFeedClip {
  return {
    ...clip,
    author: clip.author ?? { username: null, displayName: "Player", avatarUrl: null },
    likeCount: clip.likeCount ?? 0,
    commentCount: clip.commentCount ?? 0,
    liked: Boolean(clip.liked),
  };
}

export async function fetchPublicFeed(accessToken?: string | null): Promise<PublicFeedClip[]> {
  const response = await fetch(`${publicApiUrl()}/v1/clips/public?limit=24`, {
    headers: authHeaders(accessToken),
  });
  const body = (await response.json()) as { clips?: PublicFeedClip[]; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load public clips.");
  return (body.clips ?? []).map(normalize);
}

export async function setClipLiked(slug: string, liked: boolean, accessToken: string) {
  const response = await fetch(`${publicApiUrl()}/v1/clips/${slug}/like`, {
    method: liked ? "POST" : "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = (await response.json()) as { liked?: boolean; likeCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not update that like.");
  return { liked: Boolean(body.liked), likeCount: Number(body.likeCount) || 0 };
}

export async function fetchClipComments(slug: string, accessToken?: string | null): Promise<ClipComment[]> {
  const response = await fetch(`${publicApiUrl()}/v1/clips/${slug}/comments`, {
    headers: authHeaders(accessToken),
  });
  const body = (await response.json()) as { comments?: ClipComment[]; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load comments.");
  return body.comments ?? [];
}

export async function postClipComment(slug: string, text: string, accessToken: string) {
  const response = await fetch(`${publicApiUrl()}/v1/clips/${slug}/comments`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ body: text }),
  });
  const body = (await response.json()) as { comments?: ClipComment[]; commentCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not post that comment.");
  return { comments: body.comments ?? [], commentCount: Number(body.commentCount) || 0 };
}

export async function deleteClipComment(slug: string, commentId: string, accessToken: string) {
  const response = await fetch(`${publicApiUrl()}/v1/clips/${slug}/comments/${commentId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = (await response.json()) as { commentCount?: number; error?: string };
  if (!response.ok) throw new Error(body.error || "Could not delete that comment.");
  return { commentCount: Number(body.commentCount) || 0 };
}
