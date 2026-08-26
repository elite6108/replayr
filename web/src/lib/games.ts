import { readApiJson } from "./http";
import { apiUrl, getSupabase } from "./supabase";

export interface CatalogGame {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
}

export interface ClipAuthor {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
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
  downloadReady?: boolean;
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

export interface PublicClipCard {
  id: string;
  title: string | null;
  slug: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  game: { name: string; slug: string; coverUrl: string | null } | null;
  author: ClipAuthor;
  likeCount: number;
  commentCount: number;
  liked: boolean;
}

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
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

export async function fetchPublicClips(accessToken?: string | null): Promise<PublicClipCard[]> {
  const response = await fetch(apiUrl("/v1/clips/public?limit=24"), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{ clips?: PublicClipCard[] }>(response, "Could not load public clips.");
  return (body.clips ?? []).map(normalizePublicClip);
}

export async function fetchFriendClips(accessToken: string): Promise<PublicClipCard[]> {
  const response = await fetch(apiUrl("/v1/clips/friends?limit=24"), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{ clips?: PublicClipCard[] }>(response, "Could not load friends’ clips.");
  return (body.clips ?? []).map(normalizePublicClip);
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
  if (!body.game) {
    throw new Error("Could not load that game.");
  }
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
