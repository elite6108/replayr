import type { Env } from "./env";
import { HttpError } from "./http";
import { serviceRest } from "./shared";
import {
  isDeniedProcess,
  isReportableProcess,
  mergeProcessNames,
  parseGameDraft,
  parseSteamSearch,
  searchTerm,
  shouldPromote,
  slugifyGameName,
  steamHeaderUrl,
  titleIsExecutable,
  cleanWindowTitle,
  type CatalogGame,
  type CatalogWrite,
  type GameDraft,
  type ObservationInput,
  type SteamHit,
} from "./gameCatalog";

type GameRow = {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  cover_url: string | null;
  process_names: string[] | null;
  catalog_source: string | null;
};

type ObservationRow = {
  process_name: string;
  window_title: string;
  distinct_installs: number;
  title_votes: number;
  promoted_slug: string | null;
  last_seen_at: string;
};

type BlockRow = {
  process_name: string;
  note: string | null;
  created_at: string;
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

export type ObservationResult = {
  stored: boolean;
  promotedSlug: string | null;
};

const GAME_COLUMNS = "id,slug,name,publisher,cover_url,process_names,catalog_source";

export async function listCatalogGames(env: Env, query: string): Promise<CatalogGame[]> {
  const term = searchTerm(query);
  const filter = term
    ? `&or=(name.ilike.*${encodeURIComponent(term)}*,slug.ilike.*${encodeURIComponent(term)}*)`
    : "";
  const rows = await serviceRest<GameRow[]>(
    env,
    "GET",
    `/games?select=${GAME_COLUMNS}&order=name.asc&limit=40${filter}`,
  );
  return rows.map(toCatalogGame);
}

export async function saveCatalogGame(env: Env, input: CatalogWrite, existingSlug?: string): Promise<{ game: CatalogGame; created: boolean }> {
  const slug = existingSlug ? slugifyGameName(existingSlug) : input.slug;
  await assertProcessesAvailable(env, input.processNames, slug);
  const current = existingSlug ? await gameBySlug(env, slug) : null;
  if (existingSlug && !current) throw new HttpError(404, "That game is not in the catalog.");
  const saved = current
    ? await updateGame(env, slug, {
        name: input.name,
        publisher: input.publisher,
        cover_url: input.coverUrl,
        process_names: input.processNames,
        catalog_source: "staff",
      })
    : await insertGame(env, {
        slug,
        name: input.name,
        publisher: input.publisher,
        cover_url: input.coverUrl,
        process_names: input.processNames,
        catalog_source: "staff",
      });
  return { game: toCatalogGame(saved), created: !current };
}

export async function searchSteamCatalog(env: Env, query: string): Promise<SteamHit[]> {
  const term = searchTerm(query);
  if (!term) throw new HttpError(400, "Enter at least two characters.");
  try {
    const live = await fetchSteamSearch(term);
    if (live.length > 0) {
      await cacheSteamHits(env, live).catch(() => undefined);
      return live;
    }
  } catch {
    /* fall through to the local cache */
  }
  return searchCachedSteam(env, term);
}

export async function draftCatalogGame(env: Env, name: string, steamAppId?: number): Promise<GameDraft> {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 80) throw new HttpError(400, "Enter the game's name.");
  if (!env.OPENAI_API_KEY) throw new HttpError(503, "Add OPENAI_API_KEY to the Worker to enable AI drafts.");
  const appId = steamAppId && steamHeaderUrl(steamAppId) ? steamAppId : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You draft a Replayr game-catalog row. Return JSON {\"name\":\"...\",\"publisher\":\"...\",\"processNames\":[\"Game.exe\"]}. processNames are Windows executables you are confident belong to that game. Use an empty array when unsure. Never include browsers, Discord, Steam, Epic, Riot Client, Battle.net, or Windows processes. Do not invent a cover URL.",
          },
          {
            role: "user",
            content: `Official name: ${cleaned}\nSteam app id: ${appId ?? "unknown"}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new HttpError(502, "AI draft failed.");
    const content = payload.choices?.[0]?.message?.content || "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
    const draft = parseGameDraft(parsed, appId);
    if (!draft) throw new HttpError(502, "AI draft returned unusable details.");
    return { ...draft, name: draft.name || cleaned };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listLearnedProcesses(env: Env): Promise<LearnedProcess[]> {
  const [observations, blocks] = await Promise.all([
    serviceRest<ObservationRow[]>(
      env,
      "GET",
      "/game_observations?select=process_name,window_title,distinct_installs,title_votes,promoted_slug,last_seen_at&order=distinct_installs.desc,last_seen_at.desc&limit=40",
    ),
    serviceRest<BlockRow[]>(env, "GET", "/game_process_blocks?select=process_name,note,created_at&order=created_at.desc&limit=80"),
  ]);
  const blocked = new Set(blocks.map((row) => row.process_name));
  const seen = new Set(observations.map((row) => row.process_name));
  const rows: LearnedProcess[] = observations.map((row) => ({
    processName: row.process_name,
    windowTitle: row.window_title,
    distinctInstalls: row.distinct_installs,
    titleVotes: row.title_votes,
    promotedSlug: row.promoted_slug,
    lastSeenAt: row.last_seen_at,
    blocked: blocked.has(row.process_name),
  }));
  for (const block of blocks) {
    if (seen.has(block.process_name)) continue;
    rows.push({
      processName: block.process_name,
      windowTitle: block.note || "Blocked",
      distinctInstalls: 0,
      titleVotes: 0,
      promotedSlug: null,
      lastSeenAt: block.created_at,
      blocked: true,
    });
  }
  return rows;
}

export async function blockLearnedProcess(env: Env, processName: string, note: string | null): Promise<void> {
  await serviceRest(
    env,
    "POST",
    "/game_process_blocks?on_conflict=process_name",
    { process_name: processName, note },
    "resolution=merge-duplicates,return=minimal",
  );
  const existing = await findGameByProcess(env, processName);
  if (existing?.catalog_source === "observation") {
    const next = (existing.process_names ?? []).filter((name) => name.toLowerCase() !== processName);
    await updateGame(env, existing.slug, { process_names: next });
  }
}

export async function unblockLearnedProcess(env: Env, processName: string): Promise<void> {
  await serviceRest(env, "DELETE", `/game_process_blocks?process_name=eq.${encodeURIComponent(processName)}`);
}

export async function promoteLearnedProcess(env: Env, processName: string, requestedTitle: string): Promise<CatalogGame> {
  if (isDeniedProcess(processName) || !isReportableProcess(processName)) {
    throw new HttpError(400, "Browsers, launchers, and Windows apps can't be added to detection.");
  }
  const blocked = await serviceRest<BlockRow[]>(
    env,
    "GET",
    `/game_process_blocks?select=process_name&process_name=eq.${encodeURIComponent(processName)}&limit=1`,
  );
  if (blocked.length > 0) throw new HttpError(400, "Unblock that process before adding it.");
  let title = cleanWindowTitle(requestedTitle);
  if (!title || titleIsExecutable(title, processName)) {
    const rows = await serviceRest<Array<{ window_title: string }>>(
      env,
      "GET",
      `/game_observations?select=window_title&process_name=eq.${encodeURIComponent(processName)}&limit=1`,
    );
    title = rows[0] ? cleanWindowTitle(rows[0].window_title) : null;
  }
  if (!title || titleIsExecutable(title, processName)) {
    throw new HttpError(400, "That window title can't be used as the game name.");
  }
  const game = await upsertDetectedProcess(env, processName, title, "staff");
  await serviceRest(
    env,
    "PATCH",
    `/game_observations?process_name=eq.${encodeURIComponent(processName)}`,
    { promoted_slug: game.slug },
    "return=minimal",
  ).catch(() => undefined);
  return toCatalogGame(game);
}

export async function recordPlayObservation(env: Env, input: ObservationInput): Promise<ObservationResult> {
  if (isDeniedProcess(input.processName)) return { stored: false, promotedSlug: null };
  const result = await serviceRest<{
    stored?: boolean;
    blocked?: boolean;
    distinctInstalls?: number;
    distinctNetworks?: number;
    winningTitle?: string;
    winningVotes?: number;
  }>(env, "POST", "/rpc/record_game_observation", {
    p_process: input.processName,
    p_title: input.windowTitle,
    p_hash: input.installHash,
    p_network: input.networkHash,
  });
  if (!result?.stored || result.blocked) return { stored: false, promotedSlug: null };
  const distinctInstalls = Number(result.distinctInstalls ?? 0);
  const distinctNetworks = Number(result.distinctNetworks ?? 0);
  const winningVotes = Number(result.winningVotes ?? 0);
  const winningTitle = typeof result.winningTitle === "string" ? result.winningTitle : "";
  if (
    !shouldPromote({
      processName: input.processName,
      distinctInstalls,
      distinctNetworks,
      winningTitle,
      winningVotes,
      blocked: false,
    })
  ) {
    return { stored: true, promotedSlug: null };
  }
  try {
    const game = await upsertDetectedProcess(env, input.processName, winningTitle, "observation");
    await serviceRest(
      env,
      "PATCH",
      `/game_observations?process_name=eq.${encodeURIComponent(input.processName)}`,
      { promoted_slug: game.slug },
      "return=minimal",
    );
    return { stored: true, promotedSlug: game.slug };
  } catch (caught) {
    console.error("game_promote_failed", caught instanceof Error ? caught.name : "unknown");
    return { stored: true, promotedSlug: null };
  }
}

async function upsertDetectedProcess(
  env: Env,
  processName: string,
  title: string,
  source: "staff" | "observation",
): Promise<GameRow> {
  const existing = await findGameByProcess(env, processName);
  if (existing) {
    if (source === "observation" && existing.catalog_source !== "observation") return existing;
    const patch: Record<string, unknown> = {
      process_names: mergeProcessNames(existing.process_names ?? [], [processName]),
    };
    if (source === "staff" || existing.catalog_source === "observation") patch.name = title;
    if (source === "staff") patch.catalog_source = "staff";
    return updateGame(env, existing.slug, patch);
  }
  const slug = await unusedSlug(env, slugifyGameName(title), processName);
  return insertGame(env, {
    slug,
    name: title,
    publisher: null,
    cover_url: null,
    process_names: [processName],
    catalog_source: source,
  });
}

async function unusedSlug(env: Env, base: string, processName: string): Promise<string> {
  const stem = processName.replace(/\.exe$/, "").replace(/[^a-z0-9]+/g, "").slice(0, 20) || "exe";
  const candidates = [base, `${base.slice(0, 48)}-${stem}`.replace(/^-/, "")];
  for (const slug of candidates) {
    if (!(await gameBySlug(env, slug))) return slug;
  }
  return `${base.slice(0, 52)}-${stem.slice(0, 6)}-2`;
}

async function assertProcessesAvailable(env: Env, processNames: string[], slug: string): Promise<void> {
  for (const processName of processNames) {
    const existing = await findGameByProcess(env, processName);
    if (existing && existing.slug !== slug) {
      throw new HttpError(409, `${processName} is already used by ${existing.name}.`);
    }
  }
}

async function findGameByProcess(env: Env, processName: string): Promise<GameRow | null> {
  const rows = await serviceRest<GameRow[]>(env, "POST", "/rpc/game_by_process", { p_process: processName });
  return rows[0] ?? null;
}

async function gameBySlug(env: Env, slug: string): Promise<GameRow | null> {
  const rows = await serviceRest<GameRow[]>(
    env,
    "GET",
    `/games?select=${GAME_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`,
  );
  return rows[0] ?? null;
}

async function insertGame(env: Env, row: Record<string, unknown>): Promise<GameRow> {
  const rows = await serviceRest<GameRow[]>(env, "POST", "/games", row, "return=representation");
  const saved = rows[0];
  if (!saved) throw new HttpError(502, "Could not save that game.");
  return saved;
}

async function updateGame(env: Env, slug: string, patch: Record<string, unknown>): Promise<GameRow> {
  const rows = await serviceRest<GameRow[]>(
    env,
    "PATCH",
    `/games?select=${GAME_COLUMNS}&slug=eq.${encodeURIComponent(slug)}`,
    patch,
    "return=representation",
  );
  const saved = rows[0];
  if (!saved) throw new HttpError(404, "That game is not in the catalog.");
  return saved;
}

async function fetchSteamSearch(term: string): Promise<SteamHit[]> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Replayr/catalog" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return parseSteamSearch(await response.json().catch(() => null));
  } finally {
    clearTimeout(timeout);
  }
}

async function cacheSteamHits(env: Env, hits: SteamHit[]): Promise<void> {
  const rows = hits.map((hit) => ({
    app_id: hit.appId,
    name: hit.name,
    cover_url: hit.coverUrl,
    updated_at: new Date().toISOString(),
  }));
  await serviceRest(env, "POST", "/steam_apps?on_conflict=app_id", rows, "resolution=merge-duplicates,return=minimal");
}

async function searchCachedSteam(env: Env, term: string): Promise<SteamHit[]> {
  const rows = await serviceRest<Array<{ app_id: number; name: string; cover_url: string | null }>>(
    env,
    "GET",
    `/steam_apps?select=app_id,name,cover_url&name=ilike.*${encodeURIComponent(term)}*&order=name.asc&limit=12`,
  );
  return rows.map((row) => ({ appId: row.app_id, name: row.name, coverUrl: row.cover_url }));
}

function toCatalogGame(row: GameRow): CatalogGame {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    publisher: row.publisher,
    coverUrl: row.cover_url,
    processNames: row.process_names ?? [],
    catalogSource: row.catalog_source ?? "catalog",
  };
}
