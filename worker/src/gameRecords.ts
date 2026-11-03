import type { Env } from "./env";
import { HttpError, json } from "./http";
import { assertRateLimit } from "./rateLimit";
import { isClipUuid, optionalUser, requireUser, serviceRest, serviceRestCount } from "./shared";
import {
  cleanSearchTerm,
  matchStatusForSource,
  normalizeExe,
  normalizeLauncherId,
  normalizeLauncherKind,
  normalizeTitle,
  resolveGame,
  type CaptureHint,
  type GameStatus,
  type MatchGame,
  type StoredMatch,
} from "./gameMatch";

interface GameRow {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  cover_url: string | null;
  status: GameStatus;
  aliases?: string[] | null;
  steam_app_id?: number | null;
  process_names?: string[] | null;
  catalog_source?: string | null;
}

interface MatchRow {
  id: string;
  game_id: string;
  exe_name: string | null;
  launcher_kind: string | null;
  launcher_id: string | null;
  status: GameStatus;
  confirmation_count: number;
}

const BLOCKED_NAMES = new Set(["discord", "chrome", "firefox", "desktop", "replayr", "spotify", "steam"]);
const PENDING_GAME_CAP = 10;

const GAME_PUBLIC = "id,slug,name,publisher,cover_url,status";

export function captureFromBody(body: {
  captureExe?: string | null;
  captureLauncherKind?: string | null;
  captureLauncherId?: string | null;
  captureTitle?: string | null;
}): CaptureHint {
  return {
    exe: normalizeExe(body.captureExe),
    launcherKind: normalizeLauncherKind(body.captureLauncherKind),
    launcherId: normalizeLauncherId(body.captureLauncherId),
    title: normalizeTitle(body.captureTitle),
  };
}

export async function resolveClipGame(env: Env, hint: CaptureHint): Promise<string | null> {
  const exe = hint.exe;
  const kind = hint.launcherKind;
  const launcherId = hint.launcherId;
  const title = hint.title;
  if (!exe && !(kind && launcherId) && !title) return null;

  const blocked = new Set<string>();
  if (exe) {
    const rows = await serviceRest<{ process_name: string }[]>(
      env,
      "GET",
      `/game_process_blocks?process_name=eq.${encodeURIComponent(exe)}&select=process_name&limit=1`,
    );
    for (const row of rows) blocked.add(row.process_name);
  }

  const filters: string[] = [];
  if (exe) filters.push(`exe_name.eq.${encodeURIComponent(exe)}`);
  if (kind && launcherId) {
    filters.push(`and(launcher_kind.eq.${kind},launcher_id.eq.${encodeURIComponent(launcherId)})`);
  }
  const matches = filters.length
    ? await serviceRest<MatchRow[]>(
        env,
        "GET",
        `/game_matches?or=(${filters.join(",")})&select=id,game_id,exe_name,launcher_kind,launcher_id,status,confirmation_count&limit=20`,
      )
    : [];

  const games = await serviceRest<GameRow[]>(
    env,
    "GET",
    `/games?status=eq.confirmed&process_names=neq.{}&select=id,name,aliases,steam_app_id,status,process_names&limit=400`,
  );
  if (kind === "steam" && launcherId) {
    const bySteam = await serviceRest<GameRow[]>(
      env,
      "GET",
      `/games?steam_app_id=eq.${encodeURIComponent(launcherId)}&status=eq.confirmed&select=id,name,aliases,steam_app_id,status,process_names&limit=1`,
    );
    games.push(...bySteam);
  }
  if (title) {
    const term = encodeURIComponent(title);
    const byName = await serviceRest<GameRow[]>(
      env,
      "GET",
      `/games?status=eq.confirmed&or=(name.ilike.*${term}*,aliases.cs.{"${term}"})&select=id,name,aliases,steam_app_id,status,process_names&limit=12`,
    );
    games.push(...byName);
  }

  return resolveGame(hint, games.map(toMatchGame), matches.map(toStoredMatch), blocked);
}

export async function searchGames(request: Request, env: Env, url: URL): Promise<Response> {
  assertRateLimit(request, "game-search", 30);
  const term = cleanSearchTerm(url.searchParams.get("q"));
  if (!term) return json({ games: [] });
  const encoded = encodeURIComponent(term);
  const filter = `or=(name.ilike.*${encoded}*,slug.ilike.*${encoded}*)&select=${GAME_PUBLIC}&order=name.asc&limit=12`;
  const viewer = await optionalUser(request, env);
  const confirmed = await serviceRest<GameRow[]>(env, "GET", `/games?status=eq.confirmed&${filter}`);
  const ownPending =
    viewer && isClipUuid(viewer.id)
      ? await serviceRest<GameRow[]>(
          env,
          "GET",
          `/games?status=eq.pending&created_by=eq.${viewer.id}&${filter}`,
        )
      : [];
  return json({ games: [...confirmed, ...ownPending].map(toPublicGame) });
}

export async function createPendingGame(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  assertRateLimit(request, `game-create:${user.id}`, 10);
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  const raw = typeof body?.name === "string" ? body.name.replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim() : "";
  const title = normalizeTitle(raw);
  if (!title) return json({ error: "Enter a game name." }, 400);
  if (BLOCKED_NAMES.has(title) || blockedExeName(title)) {
    return json({ error: "That name is not a game." }, 400);
  }
  const existingId = await resolveClipGame(env, { exe: null, launcherKind: null, launcherId: null, title });
  if (existingId) {
    const rows = await serviceRest<GameRow[]>(env, "GET", `/games?id=eq.${existingId}&select=${GAME_PUBLIC}&limit=1`);
    if (rows[0]) return json({ game: toPublicGame(rows[0]), created: false });
  }
  const open = await serviceRestCount(
    env,
    `/games?created_by=eq.${user.id}&status=eq.pending&catalog_source=eq.user&select=id`,
  );
  if (open >= PENDING_GAME_CAP) {
    return json({ error: "You already have 10 games waiting for review." }, 429);
  }
  const slug = await insertPendingGame(env, title, raw.slice(0, 80), user.id);
  const rows = await serviceRest<GameRow[]>(env, "GET", `/games?slug=eq.${encodeURIComponent(slug)}&select=${GAME_PUBLIC}&limit=1`);
  const game = rows[0];
  if (!game) return json({ error: "Could not add that game." }, 500);
  return json({ game: toPublicGame(game), created: true }, 201);
}

export async function setClipGame(request: Request, env: Env, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!isClipUuid(clipId)) return json({ error: "Clip not found." }, 404);
  const body = (await request.json().catch(() => null)) as { gameId?: string } | null;
  const gameId = body?.gameId?.trim() ?? "";
  if (!isClipUuid(gameId)) return json({ error: "Choose a game." }, 400);

  const clips = await serviceRest<{ id: string; capture_exe: string | null }[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&user_id=eq.${user.id}&select=id,capture_exe&limit=1`,
  );
  if (!clips[0]) return json({ error: "Clip not found." }, 404);
  const games = await serviceRest<GameRow[]>(
    env,
    "GET",
    `/games?id=eq.${gameId}&select=id,status,catalog_source&limit=1`,
  );
  const game = games[0];
  if (!game) return json({ error: "That game was not found." }, 404);

  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, { game_id: gameId });

  let status = game.status;
  const exe = normalizeExe(clips[0].capture_exe);
  if (exe) {
    const blocked = await serviceRest<{ process_name: string }[]>(
      env,
      "GET",
      `/game_process_blocks?process_name=eq.${encodeURIComponent(exe)}&select=process_name&limit=1`,
    );
    if (blocked.length === 0) status = await confirmExe(env, user.id, exe, game);
  }

  return json({ gameId, status });
}

async function confirmExe(env: Env, userId: string, exe: string, game: GameRow): Promise<GameStatus> {
  const found = await serviceRest<MatchRow[]>(
    env,
    "GET",
    `/game_matches?exe_name=eq.${encodeURIComponent(exe)}&game_id=eq.${game.id}&select=id,game_id,exe_name,launcher_kind,launcher_id,status,confirmation_count&limit=1`,
  );
  let match = found[0];
  if (!match) {
    try {
      const inserted = await serviceRest<MatchRow[]>(
        env,
        "POST",
        "/game_matches",
        { game_id: game.id, exe_name: exe, status: "pending", confirmation_count: 0 },
        "return=representation",
      );
      match = inserted[0];
    } catch (caught) {
      const text = caught instanceof HttpError ? caught.message : "";
      if (!(caught instanceof HttpError) || (caught.status !== 409 && !/duplicate|unique/i.test(text))) throw caught;
      const again = await serviceRest<MatchRow[]>(
        env,
        "GET",
        `/game_matches?exe_name=eq.${encodeURIComponent(exe)}&game_id=eq.${game.id}&select=id,game_id,exe_name,launcher_kind,launcher_id,status,confirmation_count&limit=1`,
      );
      match = again[0];
    }
  }
  if (!match) return game.status;
  await serviceRest(
    env,
    "POST",
    "/game_match_confirmations?on_conflict=match_id,user_id",
    { match_id: match.id, user_id: userId },
    "resolution=ignore-duplicates,return=minimal",
  );
  const count = await serviceRest<{ user_id: string }[]>(
    env,
    "GET",
    `/game_match_confirmations?match_id=eq.${match.id}&select=user_id&limit=20`,
  );
  const status = matchStatusForSource(count.length, game.catalog_source ?? null);
  await serviceRest(env, "PATCH", `/game_matches?id=eq.${match.id}`, {
    confirmation_count: count.length,
    status,
  });
  return game.status;
}

function blockedExeName(title: string): boolean {
  const exe = normalizeExe(title.endsWith(".exe") ? title : `${title.replace(/ /g, "")}.exe`);
  return exe !== null && ["discord.exe", "chrome.exe", "firefox.exe", "spotify.exe", "steam.exe"].includes(exe);
}

async function insertPendingGame(env: Env, title: string, displayName: string, userId: string): Promise<string> {
  const base = title.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "game";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      await serviceRest(
        env,
        "POST",
        "/games",
        {
          slug,
          name: displayName,
          aliases: [title],
          status: "pending",
          catalog_source: "user",
          created_by: userId,
          process_names: [],
        },
        "return=minimal",
      );
      return slug;
    } catch (caught) {
      const text = caught instanceof HttpError ? caught.message : "";
      if (caught instanceof HttpError && (caught.status === 409 || /duplicate|unique/i.test(text))) continue;
      throw caught;
    }
  }
  throw new HttpError(500, "Could not add that game.");
}

function toMatchGame(row: GameRow): MatchGame {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    steamAppId: row.steam_app_id == null ? null : String(row.steam_app_id),
    status: row.status,
    processNames: row.process_names ?? [],
  };
}

function toStoredMatch(row: MatchRow): StoredMatch {
  return {
    gameId: row.game_id,
    exeName: row.exe_name,
    launcherKind: row.launcher_kind,
    launcherId: row.launcher_id,
    status: row.status,
    confirmationCount: row.confirmation_count,
  };
}

function toPublicGame(row: GameRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    publisher: row.publisher,
    coverUrl: row.cover_url,
    status: row.status,
  };
}
