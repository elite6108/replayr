import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import type { Env } from "./env";
import {
  isReportableProcess,
  parseCatalogWrite,
  parseObservation,
  type CatalogActor,
} from "./gameCatalog";
import {
  blockLearnedProcess,
  draftCatalogGame,
  listCatalogGames,
  listLearnedProcesses,
  matchSteamTitle,
  promoteLearnedProcess,
  recordPlayObservation,
  saveCatalogGame,
  searchSteamCatalog,
  unblockLearnedProcess,
} from "./gameCatalogStore";
import { HttpError, json } from "./http";
import { allowRateLimit, assertRateLimit } from "./rateLimit";

export async function handleGameCatalogAdmin(
  request: Request,
  env: Env,
  url: URL,
  actor: CatalogActor,
): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/v1/admin/games" && !path.startsWith("/v1/admin/games/")) return null;

  if (request.method === "GET" && path === "/v1/admin/games") {
    return json({ games: await listCatalogGames(env, url.searchParams.get("q") ?? "") });
  }
  if (request.method === "POST" && path === "/v1/admin/games") {
    const parsed = parseCatalogWrite(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const saved = await saveCatalogGame(env, parsed.value);
    await audit(env, actor, saved.created ? AUDIT_ACTIONS.gamesCatalogCreated : AUDIT_ACTIONS.gamesCatalogUpdated, saved.game.slug, {
      name: saved.game.name,
      processes: saved.game.processNames.length,
    });
    return json({ game: saved.game }, saved.created ? 201 : 200);
  }
  if (request.method === "POST" && path === "/v1/admin/games/draft") {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name : "";
    const steamAppId = typeof body.steamAppId === "number" ? body.steamAppId : undefined;
    const draft = await draftCatalogGame(env, name, steamAppId);
    return json({ draft });
  }
  if (request.method === "GET" && path === "/v1/admin/games/steam") {
    return json({ hits: await searchSteamCatalog(env, url.searchParams.get("q") ?? "") });
  }
  if (request.method === "GET" && path === "/v1/admin/games/observations") {
    return json({ observations: await listLearnedProcesses(env) });
  }

  const learned = path.match(/^\/v1\/admin\/games\/observations\/([^/]+)\/(block|unblock|promote)$/);
  if (request.method === "POST" && learned?.[1] && learned[2]) {
    const processName = learnedProcess(learned[1]);
    if (learned[2] === "block") {
      const body = await readJson(request);
      const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      await blockLearnedProcess(env, processName, note || null);
      await audit(env, actor, AUDIT_ACTIONS.gamesProcessBlocked, processName, { processName });
      return json({ ok: true });
    }
    if (learned[2] === "unblock") {
      await unblockLearnedProcess(env, processName);
      await audit(env, actor, AUDIT_ACTIONS.gamesProcessUnblocked, processName, { processName });
      return json({ ok: true });
    }
    const body = await readJson(request);
    const title = typeof body.name === "string" ? body.name : "";
    const game = await promoteLearnedProcess(env, processName, title);
    await audit(env, actor, AUDIT_ACTIONS.gamesObservationPromoted, game.slug, { processName, name: game.name });
    return json({ game });
  }

  const slugMatch = path.match(/^\/v1\/admin\/games\/([^/]+)$/);
  if (request.method === "PATCH" && slugMatch?.[1]) {
    const parsed = parseCatalogWrite(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const saved = await saveCatalogGame(env, parsed.value, decodeURIComponent(slugMatch[1]));
    await audit(env, actor, AUDIT_ACTIONS.gamesCatalogUpdated, saved.game.slug, {
      name: saved.game.name,
      processes: saved.game.processNames.length,
    });
    return json({ game: saved.game });
  }

  throw new HttpError(404, "Not found.");
}

export async function matchSteamGame(request: Request, env: Env): Promise<Response> {
  assertRateLimit(request, "steam-match", 30);
  const raw = await request.text();
  if (raw.length > 2_000) throw new HttpError(400, "That game title was not usable.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "That game title was not usable.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "That game title was not usable.");
  }
  const record = body as Record<string, unknown>;
  const processName = typeof record.processName === "string" ? record.processName : "";
  const windowTitle = typeof record.windowTitle === "string" ? record.windowTitle : "";
  if (!isReportableProcess(processName) || !windowTitle.trim()) {
    return json({ game: null });
  }
  try {
    const game = await matchSteamTitle(env, processName, windowTitle);
    return json({ game });
  } catch (caught) {
    if (caught instanceof HttpError && caught.status < 500) throw caught;
    console.error("steam_match_failed");
    throw new HttpError(500, "Could not match that game.");
  }
}

export async function ingestGameObservation(request: Request, env: Env): Promise<Response> {
  assertRateLimit(request, "game-observation", 30);
  const raw = await request.text();
  if (raw.length > 2_000) throw new HttpError(400, "Play report was not usable.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Play report was not usable.");
  }
  const parsed = parseObservation(body);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  if (!allowRateLimit(`game-obs-hash:${parsed.value.installHash}`, 20, 60 * 60 * 1000)) {
    return json({ ok: true });
  }
  try {
    const result = await recordPlayObservation(env, {
      ...parsed.value,
      networkHash: await networkHash(env, request, parsed.value.processName),
    });
    if (result.promotedSlug) {
      await writeAuditLog(env, {
        actorType: "system",
        action: AUDIT_ACTIONS.gamesObservationPromoted,
        targetType: "game",
        targetId: result.promotedSlug,
        metadata: { processName: parsed.value.processName, name: parsed.value.windowTitle },
      });
    }
    return json({ ok: true });
  } catch (caught) {
    if (caught instanceof HttpError && caught.status < 500) throw caught;
    console.error("game_observation_failed");
    throw new HttpError(500, "Could not save that play report.");
  }
}

async function networkHash(env: Env, request: Request, processName: string): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const pepper = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${pepper}\n${ip}\n${processName}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function learnedProcess(value: string): string {
  const processName = decodeURIComponent(value).trim().toLowerCase();
  if (!isReportableProcess(processName)) throw new HttpError(400, "That process name is not usable.");
  return processName;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

async function audit(env: Env, actor: CatalogActor, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
  await writeAuditLog(env, {
    actorUserId: actor.id,
    actorType: "admin",
    action,
    targetType: "game",
    targetId,
    metadata,
    requestId: actor.requestId,
  });
}
