import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

export type CatalogGame = {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
  processNames: string[];
  catalogSource: string;
};

export type SteamHit = {
  appId: number;
  name: string;
  coverUrl: string | null;
};

export type GameDraft = {
  name: string;
  publisher: string | null;
  processNames: string[];
  coverUrl: string | null;
};

export type LearnedProcess = {
  processName: string;
  windowTitle: string;
  distinctInstalls: number;
  titleVotes: number;
  promotedSlug: string | null;
  lastSeenAt: string | null;
  blocked: boolean;
};

async function adminFetch<T>(token: string, path: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return readApiJson<T>(response, fallback);
}

export function fetchCatalogGames(token: string, query: string) {
  const path = query.trim() ? `/v1/admin/games?q=${encodeURIComponent(query.trim())}` : "/v1/admin/games";
  return adminFetch<{ games: CatalogGame[] }>(token, path, { method: "GET" }, "Could not load the game catalog.").then((body) => body.games);
}

export function saveCatalogGame(token: string, game: Record<string, unknown>, slug?: string) {
  return adminFetch<{ game: CatalogGame }>(
    token,
    slug ? `/v1/admin/games/${encodeURIComponent(slug)}` : "/v1/admin/games",
    { method: slug ? "PATCH" : "POST", body: JSON.stringify(game) },
    "Could not save that game.",
  ).then((body) => body.game);
}

export function draftCatalogGame(token: string, name: string, steamAppId?: number) {
  return adminFetch<{ draft: GameDraft }>(
    token,
    "/v1/admin/games/draft",
    { method: "POST", body: JSON.stringify({ name, steamAppId }) },
    "Could not draft that game.",
  ).then((body) => body.draft);
}

export function searchSteamGames(token: string, query: string) {
  return adminFetch<{ hits: SteamHit[] }>(
    token,
    `/v1/admin/games/steam?q=${encodeURIComponent(query.trim())}`,
    { method: "GET" },
    "Could not search Steam.",
  ).then((body) => body.hits);
}

export function fetchLearnedProcesses(token: string) {
  return adminFetch<{ observations: LearnedProcess[] }>(
    token,
    "/v1/admin/games/observations",
    { method: "GET" },
    "Could not load learned games.",
  ).then((body) => body.observations);
}

export function blockLearnedProcess(token: string, processName: string) {
  return adminFetch<{ ok: boolean }>(
    token,
    `/v1/admin/games/observations/${encodeURIComponent(processName)}/block`,
    { method: "POST", body: JSON.stringify({}) },
    "Could not block that process.",
  );
}

export function unblockLearnedProcess(token: string, processName: string) {
  return adminFetch<{ ok: boolean }>(
    token,
    `/v1/admin/games/observations/${encodeURIComponent(processName)}/unblock`,
    { method: "POST", body: JSON.stringify({}) },
    "Could not unblock that process.",
  );
}

export function promoteLearnedProcess(token: string, processName: string, name?: string) {
  return adminFetch<{ game: CatalogGame }>(
    token,
    `/v1/admin/games/observations/${encodeURIComponent(processName)}/promote`,
    { method: "POST", body: JSON.stringify({ name }) },
    "Could not add that game.",
  ).then((body) => body.game);
}
