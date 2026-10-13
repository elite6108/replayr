import { invoke } from "@tauri-apps/api/core";
import { publicApiUrl } from "../branding";
import { syncGames } from "./tauri";
import type { DetectedGameSnapshot, GameCatalogEntry } from "../types/game";

const reported = new Set<string>();
const steamRetryAt = new Map<string, number>();

export function maybeReportLearnedGame(snapshot: Pick<DetectedGameSnapshot, "slug" | "name" | "processName">) {
  if (!snapshot.name || snapshot.slug || !snapshot.processName) return;
  const key = `${snapshot.processName.toLowerCase()}\n${snapshot.name}`;
  if (reported.has(key)) return;
  reported.add(key);
  void sendLearnedGame(snapshot.processName, snapshot.name).catch(() => {
    reported.delete(key);
  });
}

async function sendLearnedGame(processName: string, windowTitle: string) {
  const installHash = await invoke<string>("game_observation_hash", { processName });
  const response = await fetch(`${publicApiUrl()}/v1/games/observations`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ processName, windowTitle, installHash }),
  });
  if (!response.ok) throw new Error("Could not report that game.");
}

export async function attachSteamMatch(
  snapshot: Pick<DetectedGameSnapshot, "slug" | "name" | "processName">,
): Promise<GameCatalogEntry[] | null> {
  if (!snapshot.name || snapshot.slug || !snapshot.processName) return null;
  const key = `${snapshot.processName.toLowerCase()}\n${snapshot.name}`;
  if ((steamRetryAt.get(key) ?? 0) > Date.now()) return null;
  steamRetryAt.set(key, Date.now() + 60_000);
  try {
    const response = await fetch(`${publicApiUrl()}/v1/games/steam/match`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ processName: snapshot.processName, windowTitle: snapshot.name }),
    });
    if (!response.ok) throw new Error("Could not match that game.");
    const body = (await response.json()) as {
      game?: {
        id?: string;
        slug?: string;
        name?: string;
        publisher?: string | null;
        coverUrl?: string | null;
        processNames?: string[];
      } | null;
    };
    const game = body.game;
    if (!game?.slug || !game.name) return null;
    steamRetryAt.set(key, Date.now() + 24 * 60 * 60 * 1000);
    return syncGames([
      {
        slug: game.slug,
        cloudId: game.id ?? null,
        name: game.name,
        publisher: game.publisher ?? null,
        coverUrl: game.coverUrl ?? null,
        iconUrl: null,
        processNames: game.processNames?.length ? game.processNames : [snapshot.processName],
      },
    ]);
  } catch {
    steamRetryAt.delete(key);
    return null;
  }
}
