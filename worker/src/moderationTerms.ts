import {
  OBJECTIONABLE_TEXT,
  prepareTerm,
  TermInputError,
  violatesTerms,
  type TermCategory,
} from "./contentPolicy";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest, serviceRestCount } from "./shared";
import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import type { StaffActor } from "./staffAuth";

const TERM_CACHE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TermRow = {
  id: string;
  term: string;
  normalized: string;
  category: TermCategory;
  note: string | null;
  created_at: string;
  retired_at: string | null;
};

let termCache: { keys: string[]; expiresAt: number } | null = null;

export function clearTermCache(): void {
  termCache = null;
}

export async function activeTermKeys(env: Env): Promise<string[]> {
  if (termCache && termCache.expiresAt > Date.now()) return termCache.keys;
  const rows = await serviceRest<Array<{ normalized?: unknown }>>(
    env,
    "GET",
    "/moderation_terms?retired_at=is.null&select=normalized&limit=2000",
  );
  const keys = rows
    .map((row) => (typeof row.normalized === "string" ? row.normalized : ""))
    .filter((key) => key.length >= 3);
  termCache = { keys, expiresAt: Date.now() + TERM_CACHE_MS };
  return keys;
}

/** Rejects public text that matches an active term. Empty text is allowed. */
export async function assertAcceptableText(env: Env, value: string): Promise<void> {
  const text = value.trim();
  if (!text) return;
  let keys: string[];
  try {
    keys = await activeTermKeys(env);
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 400) throw caught;
    throw new HttpError(503, "Could not check that text. Try again.");
  }
  if (violatesTerms(text, keys)) throw new HttpError(400, OBJECTIONABLE_TEXT);
}

export async function listModerationTerms(env: Env, url: URL): Promise<Response> {
  const category = url.searchParams.get("category") || "";
  const state = url.searchParams.get("state") || "active";
  const q = (url.searchParams.get("q") || "").toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().slice(0, 64);
  const page = pageOf(url);
  const filters: string[] = [];
  if (state === "retired") filters.push("retired_at=not.is.null");
  else if (state !== "all") filters.push("retired_at=is.null");
  if (category && ["profanity", "slur", "sexual", "threat", "other"].includes(category)) {
    filters.push(`category=eq.${category}`);
  }
  if (q) {
    const needle = encodeURIComponent(q);
    filters.push(`or=(term.ilike.*${needle}*,normalized.ilike.*${needle}*)`);
  }
  const where = filters.length ? `&${filters.join("&")}` : "";
  const [rows, total] = await Promise.all([
    serviceRest<TermRow[]>(
      env,
      "GET",
      `/moderation_terms?select=id,term,normalized,category,note,created_at,retired_at${where}&order=retired_at.asc.nullsfirst,term.asc&limit=${page.limit}&offset=${page.offset}`,
    ),
    serviceRestCount(env, `/moderation_terms?select=id${where}`),
  ]);
  return json({
    terms: rows.map(presentTerm),
    total,
    page: page.page,
    limit: page.limit,
  });
}

export async function createModerationTerm(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { term?: unknown; category?: unknown; note?: unknown };
  let prepared;
  try {
    prepared = prepareTerm(body);
  } catch (caught) {
    if (caught instanceof TermInputError) throw new HttpError(400, caught.message);
    throw caught;
  }
  let rows: TermRow[];
  try {
    rows = await serviceRest<TermRow[]>(
      env,
      "POST",
      "/moderation_terms?select=id,term,normalized,category,note,created_at,retired_at",
      {
        term: prepared.term,
        normalized: prepared.normalized,
        category: prepared.category,
        note: prepared.note,
        created_by: actor.userId,
      },
      "return=representation",
    );
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 409) {
      throw new HttpError(409, "That term is already on the list.");
    }
    throw caught;
  }
  const row = rows[0];
  if (!row) throw new HttpError(502, "Could not save that term.");
  clearTermCache();
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.moderationTermAdded,
    targetType: "moderation_term",
    targetId: row.id,
    requestId: actor.requestId,
    metadata: { category: row.category, term: row.term },
  });
  return json({ term: presentTerm(row) }, 201);
}

export async function updateModerationTerm(
  request: Request,
  env: Env,
  actor: StaffActor,
  termId: string,
): Promise<Response> {
  if (!UUID.test(termId)) throw new HttpError(404, "That term was not found.");
  const body = (await request.json().catch(() => ({}))) as { retired?: unknown };
  if (typeof body.retired !== "boolean") throw new HttpError(400, "Say whether the term is retired.");
  const existing = await serviceRest<TermRow[]>(
    env,
    "GET",
    `/moderation_terms?id=eq.${termId}&select=id,term,normalized,category,note,created_at,retired_at`,
  );
  const current = existing[0];
  if (!current) throw new HttpError(404, "That term was not found.");
  const now = new Date().toISOString();
  let rows: TermRow[];
  try {
    rows = await serviceRest<TermRow[]>(
      env,
      "PATCH",
      `/moderation_terms?id=eq.${termId}&select=id,term,normalized,category,note,created_at,retired_at`,
      body.retired
        ? { retired_at: now, retired_by: actor.userId }
        : { retired_at: null, retired_by: null },
      "return=representation",
    );
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 409) {
      throw new HttpError(409, "That term is already on the list.");
    }
    throw caught;
  }
  const row = rows[0];
  if (!row) throw new HttpError(404, "That term was not found.");
  clearTermCache();
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: body.retired ? AUDIT_ACTIONS.moderationTermRetired : AUDIT_ACTIONS.moderationTermRestored,
    targetType: "moderation_term",
    targetId: row.id,
    requestId: actor.requestId,
    metadata: { category: row.category, term: row.term },
  });
  return json({ term: presentTerm(row) });
}

function presentTerm(row: TermRow) {
  return {
    id: row.id,
    term: row.term,
    normalized: row.normalized,
    category: row.category,
    note: row.note,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

function pageOf(url: URL) {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 50)) || 50));
  return { page, limit, offset: (page - 1) * limit };
}
