import { publicApiUrl } from "../branding";
import { readApiJson } from "../utils/http";

export interface PublicGameClip {
  id: string;
  title: string | null;
  slug: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  watermark?: boolean;
}

export interface PublicGame {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
}

export async function fetchPublicGameClips(slug: string): Promise<{ game: PublicGame; clips: PublicGameClip[] }> {
  const response = await fetch(`${publicApiUrl()}/v1/games/${encodeURIComponent(slug)}/clips`, {
    headers: { accept: "application/json" },
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
