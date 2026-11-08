import type { Env } from "./env";
import { pickBestTitleMatch } from "./gameCatalog";
import { serviceRest } from "./shared";

const IGDB_PAGE = 50;
const IGDB_PAGES_PER_RUN = 4;
const STEAM_BATCH = 200;
const STEAM_BATCHES_PER_RUN = 4;
const STEAM_REFRESH_MS = 6 * 24 * 60 * 60 * 1000;

interface ImportState {
  source: string;
  cursor: string | null;
  updated_at: string;
}

interface IgdbGame {
  id?: number;
  name?: string;
  slug?: string;
  alternative_names?: { name?: string }[];
  cover?: { url?: string };
  external_games?: { category?: number; uid?: string }[];
}

interface SteamApp {
  appid?: number;
  name?: string;
}

let twitchToken: { value: string; expiresAt: number } | null = null;

export async function importGamesBatch(env: Env): Promise<void> {
  await importIgdbPage(env);
  await importSteamSlice(env);
}

async function importIgdbPage(env: Env): Promise<void> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return;
  const token = await twitchAccessToken(env);
  if (!token) return;
  const state = await readState(env, "igdb");
  let offset = Number(state?.cursor ?? "0");
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  for (let page = 0; page < IGDB_PAGES_PER_RUN; page += 1) {
    const response = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "client-id": env.TWITCH_CLIENT_ID,
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      body: [
        "fields id,name,slug,alternative_names.name,cover.url,external_games.category,external_games.uid;",
        "where game_type = 0 & version_parent = null;",
        `limit ${IGDB_PAGE};`,
        `offset ${offset};`,
      ].join(" "),
    });
    if (response.status === 429) break;
    if (!response.ok) break;
    const rows = (await response.json()) as IgdbGame[];
    for (const row of rows) await upsertIgdbGame(env, row);
    offset += rows.length;
    if (rows.length < IGDB_PAGE) {
      offset = 0;
      break;
    }
    await sleep(300);
  }
  await writeState(env, "igdb", String(offset));
}

/** Search IGDB for the closest main game and store it. Returns the catalog slug. */
export async function importBestIgdbMainGame(env: Env, name: string): Promise<string | null> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const token = await twitchAccessToken(env);
  if (!token) return null;
  const query = name.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (query.length < 2) return null;
  const response = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "client-id": env.TWITCH_CLIENT_ID,
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    body: [
      `search "${query}";`,
      "fields id,name,slug,alternative_names.name,cover.url,external_games.category,external_games.uid;",
      "where game_type = 0 & version_parent = null;",
      "limit 8;",
    ].join(" "),
  });
  if (!response.ok) return null;
  const rows = (await response.json()) as IgdbGame[];
  const best = pickBestTitleMatch(
    query,
    rows.flatMap((row) => {
      const title = row.name?.trim();
      if (!title) return [];
      return [
        {
          row,
          name: title,
          aliases: (row.alternative_names ?? []).flatMap((item) => (item.name?.trim() ? [item.name.trim()] : [])),
        },
      ];
    }),
  );
  if (!best) return null;
  await upsertIgdbGame(env, best.row);
  const id = best.row.id;
  if (typeof id !== "number") return null;
  const saved = await serviceRest<{ slug: string }[]>(
    env,
    "GET",
    `/games?igdb_id=eq.${id}&select=slug&limit=1`,
  );
  return saved[0]?.slug ?? null;
}

async function upsertIgdbGame(env: Env, row: IgdbGame): Promise<void> {
  const name = row.name?.trim();
  const igdbSlug = row.slug?.trim().toLowerCase();
  if (!name || !igdbSlug || !/^[a-z0-9-]{2,80}$/.test(igdbSlug)) return;
  const id = row.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return;
  const steam = (row.external_games ?? []).find((item) => item.category === 1 && /^\d{1,12}$/.test(item.uid ?? ""));
  const aliases = [
    ...new Set(
      (row.alternative_names ?? [])
        .map((item) => item.name?.trim().toLowerCase() ?? "")
        .filter((alias) => alias.length >= 2 && alias.length <= 80),
    ),
  ].slice(0, 12);
  const cover = coverUrl(row.cover?.url);
  const patch = {
    name,
    aliases,
    cover_url: cover,
    steam_app_id: steam?.uid ? Number(steam.uid) : null,
    igdb_id: id,
    catalog_source: "igdb",
  };
  const existing = await serviceRest<{ id: string; catalog_source: string | null }[]>(
    env,
    "GET",
    `/games?or=(igdb_id.eq.${id},slug.eq.${encodeURIComponent(igdbSlug)})&select=id,catalog_source&limit=1`,
  );
  try {
    if (existing[0]) {
      const update =
        existing[0].catalog_source === "igdb"
          ? patch
          : { igdb_id: id, steam_app_id: patch.steam_app_id, aliases };
      await serviceRest(env, "PATCH", `/games?id=eq.${existing[0].id}`, update);
      if (igdbSlug === "fivem" || igdbSlug === "five-m") await linkUnderGta(env, igdbSlug);
      return;
    }
    await serviceRest(
      env,
      "POST",
      "/games",
      { ...patch, slug: igdbSlug, status: "confirmed", process_names: [] },
      "return=minimal",
    );
    if (igdbSlug === "fivem" || igdbSlug === "five-m") await linkUnderGta(env, igdbSlug);
  } catch {
    // A slug or Steam id collision loses this row. The next batch can retry it.
  }
}

async function linkUnderGta(env: Env, slug: string): Promise<void> {
  const parents = await serviceRest<{ id: string }[]>(env, "GET", "/games?slug=eq.gta-v&select=id&limit=1");
  const parent = parents[0];
  if (!parent) return;
  await serviceRest(env, "PATCH", `/games?slug=eq.${encodeURIComponent(slug)}&parent_game_id=is.null`, {
    parent_game_id: parent.id,
  });
}

function coverUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const withHost = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!withHost.startsWith("https://")) return null;
  return withHost.replace("/t_thumb/", "/t_cover_big/");
}

async function importSteamSlice(env: Env): Promise<void> {
  const state = await readState(env, "steam");
  const cursor = Number(state?.cursor ?? "0");
  const fresh = state?.updated_at ? Date.now() - Date.parse(state.updated_at) : STEAM_REFRESH_MS;
  if (cursor === 0 && fresh < STEAM_REFRESH_MS) return;

  const response = await fetch("https://api.steampowered.com/ISteamApps/GetAppList/v2/");
  if (!response.ok) return;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 40_000_000) return;
  const body = (await response.json()) as { applist?: { apps?: SteamApp[] } };
  if ((body.applist?.apps?.length ?? 0) > 400_000) return;
  const apps = body.applist?.apps ?? [];
  let index = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  for (let batch = 0; batch < STEAM_BATCHES_PER_RUN && index < apps.length; batch += 1) {
    const slice = apps.slice(index, index + STEAM_BATCH).flatMap((app) => {
      const name = app.name?.trim();
      if (!name || !app.appid || app.appid <= 0) return [];
      return [
        {
          app_id: app.appid,
          name: name.slice(0, 200),
          cover_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${app.appid}/header.jpg`,
        },
      ];
    });
    if (slice.length) {
      await serviceRest(env, "POST", "/steam_apps?on_conflict=app_id", slice, "resolution=merge-duplicates,return=minimal");
    }
    index += STEAM_BATCH;
  }
  await writeState(env, "steam", index >= apps.length ? "0" : String(index));
}

async function twitchAccessToken(env: Env): Promise<string | null> {
  if (twitchToken && twitchToken.expiresAt > Date.now() + 60_000) return twitchToken.value;
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID ?? "",
    client_secret: env.TWITCH_CLIENT_SECRET ?? "",
    grant_type: "client_credentials",
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!response.ok) return null;
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  twitchToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function readState(env: Env, source: string): Promise<ImportState | null> {
  const rows = await serviceRest<ImportState[]>(
    env,
    "GET",
    `/game_import_state?source=eq.${source}&select=source,cursor,updated_at&limit=1`,
  );
  return rows[0] ?? null;
}

async function writeState(env: Env, source: string, cursor: string): Promise<void> {
  await serviceRest(
    env,
    "POST",
    "/game_import_state?on_conflict=source",
    { source, cursor, updated_at: new Date().toISOString() },
    "resolution=merge-duplicates,return=minimal",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
