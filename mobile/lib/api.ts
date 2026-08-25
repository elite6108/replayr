import { readApiError, readApiJson } from "./http";
import { apiUrl, getSupabase } from "./supabase";

export interface ClipAuthor {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  verified?: boolean;
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

export interface CatalogGame {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
  clipCount?: number;
}

export interface PublicClipCard {
  id: string;
  title: string | null;
  description?: string | null;
  slug: string;
  durationMs: number | null;
  createdAt?: string;
  viewCount?: number;
  thumbnailUrl: string | null;
  game: { name: string; slug: string; coverUrl: string | null } | null;
  author: ClipAuthor;
  likeCount: number;
  commentCount: number;
  liked: boolean;
}

export interface PublicGameClip {
  id: string;
  title: string | null;
  slug: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  author?: ClipAuthor;
  likeCount?: number;
  commentCount?: number;
  liked?: boolean;
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
  const body = await readApiJson<PlaybackClip>(response, "That clip is not available.");
  return body;
}

export async function deleteCloudClip(clipId: string, accessToken: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/clips/${clipId}`), {
    method: "DELETE",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not delete that cloud clip."));
}

export async function fetchGames(): Promise<CatalogGame[]> {
  const { data, error } = await getSupabase()
    .from("games")
    .select("id, slug, name, publisher, cover_url")
    .order("name");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    publisher: row.publisher,
    coverUrl: row.cover_url,
  }));
}

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) (headers as Record<string, string>).authorization = `Bearer ${accessToken}`;
  return headers;
}

export async function fetchPublicClips(
  accessToken?: string | null,
  options?: { limit?: number; sort?: "latest" | "trending" },
): Promise<PublicClipCard[]> {
  const query = new URLSearchParams();
  query.set("limit", String(options?.limit ?? 24));
  if (options?.sort === "trending") query.set("sort", "trending");
  const response = await fetch(apiUrl(`/v1/clips/public?${query}`), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ clips?: PublicClipCard[] }>(response, "Could not load public clips.");
  return (body.clips ?? []).map(normalizePublicClip);
}

export async function fetchFriendClips(accessToken: string): Promise<PublicClipCard[]> {
  const response = await fetch(apiUrl("/v1/clips/friends?limit=24"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ clips?: PublicClipCard[] }>(response, "Could not load friends’ clips.");
  return (body.clips ?? []).map(normalizePublicClip);
}

function normalizePublicClip(clip: PublicClipCard): PublicClipCard {
  return {
    ...clip,
    author: clip.author ?? { username: null, displayName: "Player", avatarUrl: null },
    likeCount: clip.likeCount ?? 0,
    commentCount: clip.commentCount ?? 0,
    liked: Boolean(clip.liked),
  };
}

export async function fetchFavoriteGames(userId: string): Promise<CatalogGame[]> {
  const { data, error } = await getSupabase()
    .from("clips")
    .select("game_id, games(id, slug, name, publisher, cover_url)")
    .eq("user_id", userId)
    .not("game_id", "is", null)
    .limit(40);
  if (error) throw error;
  const seen = new Set<string>();
  const games: CatalogGame[] = [];
  for (const row of data ?? []) {
    const game = Array.isArray(row.games) ? row.games[0] : row.games;
    if (!game || seen.has(game.id)) continue;
    seen.add(game.id);
    games.push({
      id: game.id,
      slug: game.slug,
      name: game.name,
      publisher: game.publisher,
      coverUrl: game.cover_url,
    });
  }
  return attachPublicClipCounts(games);
}

export async function attachPublicClipCounts(games: CatalogGame[]): Promise<CatalogGame[]> {
  if (games.length === 0) return games;
  const counts = await Promise.all(
    games.map(async (game) => {
      const { count } = await getSupabase()
        .from("clips")
        .select("id", { count: "exact", head: true })
        .eq("game_id", game.id)
        .eq("visibility", "public")
        .eq("status", "ready");
      return [game.id, count ?? 0] as const;
    }),
  );
  const byId = new Map(counts);
  return games.map((game) => ({ ...game, clipCount: byId.get(game.id) ?? 0 }));
}

export async function fetchOwnProfile(userId: string) {
  const { data } = await getSupabase()
    .from("profiles")
    .select("username, display_name, avatar_url")
    .eq("id", userId)
    .maybeSingle();
  return (data as { username: string | null; display_name: string | null; avatar_url: string | null } | null) ?? null;
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

export async function fetchGameClips(
  slug: string,
  accessToken?: string | null,
): Promise<{ game: CatalogGame; clips: PublicGameClip[] }> {
  const response = await fetch(apiUrl(`/v1/games/${encodeURIComponent(slug)}/clips`), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{
    game?: { id: string; slug: string; name: string; publisher: string | null; cover_url: string | null };
    clips?: PublicGameClip[];
  }>(response, "Could not load that game.");
  if (!body.game) throw new Error("Could not load that game.");
  return {
    game: {
      id: body.game.id,
      slug: body.game.slug,
      name: body.game.name,
      publisher: body.game.publisher,
      coverUrl: body.game.cover_url,
    },
    clips: body.clips ?? [],
  };
}

export async function downloadClipBytes(slug: string, accessToken?: string | null): Promise<ArrayBuffer> {
  const headers: HeadersInit = { accept: "application/octet-stream, application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl(`/v1/clips/${slug}/download`), { headers });
  if (!response.ok) throw new Error(await readApiError(response, "Could not download that clip."));
  return response.arrayBuffer();
}

export interface BillingStatus {
  plan: string;
  status: string;
  premium: boolean;
  watermark: boolean;
  ads: boolean;
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export async function fetchBillingStatus(accessToken: string): Promise<BillingStatus> {
  const response = await fetch(apiUrl("/v1/billing/status"), {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  return readApiJson<BillingStatus>(response, "Could not load billing.");
}

export async function deleteAccount(accessToken: string): Promise<void> {
  const response = await fetch(apiUrl("/v1/account/delete"), {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not delete this account."));
}

export function clipAllowsSocial(visibility: string | undefined) {
  const value = (visibility ?? "").trim().toLowerCase();
  return value === "public" || value === "unlisted";
}

export function suggestedDownloadName(title: string | null, slug: string) {
  const base = (title || slug)
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "clip"}.mp4`;
}
