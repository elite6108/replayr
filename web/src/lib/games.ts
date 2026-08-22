import { apiUrl, getSupabase } from "./supabase";

export interface CatalogGame {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
}

export interface PublicGameClip {
  id: string;
  title: string | null;
  slug: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
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
}

export async function fetchPublicClips(): Promise<PublicClipCard[]> {
  const response = await fetch(apiUrl("/v1/clips/public"), {
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as { clips?: PublicClipCard[]; error?: string };
  if (!response.ok) {
    throw new Error(body.error || "Could not load public clips.");
  }
  return body.clips ?? [];
}

export async function fetchGameClips(slug: string): Promise<{ game: CatalogGame; clips: PublicGameClip[] }> {
  const response = await fetch(apiUrl(`/v1/games/${encodeURIComponent(slug)}/clips`), {
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as {
    game?: { id: string; slug: string; name: string; publisher: string | null; cover_url: string | null };
    clips?: PublicGameClip[];
    error?: string;
  };
  if (!response.ok || !body.game) {
    throw new Error(body.error || "Could not load that game.");
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
