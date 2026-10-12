import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import {
  analyticsSubjectForUser,
  analyticsSubjectsForErasure,
  createAnalyticsReveal,
  requireStaffAal2,
  sanitizeRevealReason,
  verifyAnalyticsReveal,
} from "./analyticsPrivacy";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { assertDistributedRateLimit } from "./rateLimit";
import { serviceRest, serviceRestCount } from "./shared";
import type { StaffActor } from "./staffAuth";
import {
  renderUserJourneyCsv,
  renderUserJourneyPdf,
  userExportContainsForbidden,
  type ExportJourneyEvent,
  type UserJourneyExportData,
} from "./analyticsUserExport";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PROPERTY_KEYS = new Set([
  "artifact",
  "bytes_bucket",
  "capture_type",
  "channel",
  "cloud",
  "cloud_uploaded",
  "conversation_type",
  "duration_bucket",
  "editor_mode",
  "failure_category",
  "filter_id",
  "folder",
  "has_clip",
  "has_text",
  "height_bucket",
  "instant_replay",
  "interval",
  "platform",
  "quality_preset",
  "render_kind",
  "render_type",
  "reason",
  "replaced_oldest",
  "save_kind",
  "screen",
  "source",
  "surface",
  "role",
  "visibility",
  "webcam_enabled",
  "width_bucket",
]);

type AuthUser = {
  id: string;
  email?: string | null;
  created_at?: string | null;
};

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type Storage = {
  storage_used_bytes: number;
  storage_limit_bytes: number;
  plans: { slug: string } | Array<{ slug: string }> | null;
};

type JourneyEvent = {
  event_name: string;
  occurred_at: string;
  platform: string | null;
  properties: Record<string, unknown> | null;
};

type JourneyRequest = {
  userId?: unknown;
  from?: unknown;
  to?: unknown;
  offset?: unknown;
  limit?: unknown;
};

type JourneyAccess = {
  userId: string;
  range: { from: string; to: string };
  eventFilter: string;
  reason: string;
};

export const USER_JOURNEY_EXPORT_EVENT_CAP = 5_000;
const EXPORT_EVENT_PAGE = 1_000;

export async function handleAnalyticsUserAdmin(
  request: Request,
  env: Env,
  url: URL,
  actor: StaffActor,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/v1/admin/analytics/users/search" && request.method === "POST") {
    return auditedJourneyAccess(request, env, actor, async () => {
      requireStaffAal2(request);
      await assertDistributedRateLimit(request, env.ANALYTICS_REVEAL_RATE_LIMITER, "analytics-user-search", 20, actor.userId);
      return searchUsers(request, env, actor);
    });
  }
  if (path === "/v1/admin/analytics/users/reveal" && request.method === "POST") {
    return auditedJourneyAccess(request, env, actor, async () => {
      requireStaffAal2(request);
      await assertDistributedRateLimit(request, env.ANALYTICS_REVEAL_RATE_LIMITER, "analytics-user-reveal", 10, actor.userId);
      return revealUser(request, env, actor);
    });
  }
  if (path === "/v1/admin/analytics/users/journey" && request.method === "POST") {
    return auditedJourneyAccess(request, env, actor, async () => {
      requireStaffAal2(request);
      await assertDistributedRateLimit(request, env.ANALYTICS_REVEAL_RATE_LIMITER, "analytics-user-journey", 30, actor.userId);
      return userJourney(request, env, actor);
    });
  }
  const exportMatch = path.match(/^\/v1\/admin\/analytics\/users\/export\/(csv|pdf)$/);
  if (exportMatch && request.method === "POST") {
    const format = exportMatch[1] as "csv" | "pdf";
    return auditedJourneyAccess(request, env, actor, async () => {
      requireStaffAal2(request);
      await assertDistributedRateLimit(
        request,
        env.ANALYTICS_REVEAL_RATE_LIMITER,
        `analytics-user-export-${format}`,
        5,
        actor.userId,
      );
      return exportUserJourney(request, env, actor, format);
    });
  }
  return null;
}

async function searchUsers(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
  const query = safeSearch(body?.query);
  const [profiles, authPage] = await Promise.all([
    serviceRest<Profile[]>(
      env,
      "GET",
      `/profiles?or=(username.ilike.*${encodeURIComponent(query)}*,display_name.ilike.*${encodeURIComponent(query)}*)&select=id,username,display_name&limit=20`,
    ),
    listAuthUsers(env, actor.serviceKey, 200),
  ]);
  const needle = query.toLowerCase();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const ids = new Set(profiles.map((profile) => profile.id));
  for (const user of authPage) {
    if (
      user.email?.toLowerCase().includes(needle) ||
      user.id.toLowerCase() === needle
    ) {
      ids.add(user.id);
    }
  }
  const authById = new Map(authPage.map((user) => [user.id, user]));
  const missingAuthIds = [...ids].filter((id) => !authById.has(id)).slice(0, 20);
  const missingUsers = await Promise.all(missingAuthIds.map((id) => getAuthUser(env, actor.serviceKey, id)));
  for (const user of missingUsers) {
    if (user) authById.set(user.id, user);
  }
  const users = [...ids].slice(0, 20).map((id) => {
    const auth = authById.get(id);
    const profile = profileById.get(id);
    return {
      userId: id,
      email: auth?.email ?? null,
      username: profile?.username ?? null,
      displayName: profile?.display_name ?? null,
      createdAt: auth?.created_at ?? null,
    };
  });
  return json({ users });
}

async function revealUser(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { userId?: unknown; reason?: unknown } | null;
  const userId = requireUserId(body?.userId);
  const reason = sanitizeRevealReason(body?.reason);
  const [authUser, profiles, subject] = await Promise.all([
      getAuthUser(env, actor.serviceKey, userId),
      serviceRest<Profile[]>(env, "GET", `/profiles?id=eq.${userId}&select=id,username,display_name&limit=1`),
      analyticsSubjectForUser(env, userId),
  ]);
  if (!authUser) throw new HttpError(404, "That account was not found.");
  if (!subject) throw new HttpError(503, "Secure analytics identity is not configured.");
  const created = await createAnalyticsReveal(env, {
      staffUserId: actor.userId,
      targetUserId: userId,
      subjectId: subject.id,
      subjectKeyVersion: subject.keyVersion,
      reason,
  });
  await writeAuditLog(env, {
      actorUserId: actor.userId,
      actorType: "admin",
      action: AUDIT_ACTIONS.analyticsJourneyRevealGranted,
      targetType: "user",
      targetId: userId,
      metadata: { reason, expiresInSeconds: 600 },
      requestId: actor.requestId,
  });
  return json({
      revealToken: created.token,
      expiresAt: new Date(created.reveal.expiresAt * 1000).toISOString(),
      user: {
        userId,
        email: authUser.email ?? null,
        username: profiles[0]?.username ?? null,
        displayName: profiles[0]?.display_name ?? null,
        createdAt: authUser.created_at ?? null,
      },
  });
}

async function userJourney(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => null)) as JourneyRequest | null;
  const access = await authorizeJourneyRequest(request, env, actor, body);
  const limit = integerWithin(body?.limit, 50, 1, 100);
  const offset = integerWithin(body?.offset, 0, 0, 5_000);
  const [summary, eventRows] = await Promise.all([
    loadJourneySummary(env, actor, access),
    loadJourneyEventPage(env, access.eventFilter, limit + 1, offset),
  ]);
  const hasMore = eventRows.length > limit;
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.analyticsJourneyViewed,
    targetType: "user",
    targetId: access.userId,
    metadata: {
      reason: access.reason,
      from: access.range.from,
      to: access.range.to,
      returnedEvents: Math.min(eventRows.length, limit),
    },
    requestId: actor.requestId,
  });
  return json({
    range: access.range,
    ...summary,
    events: eventRows.slice(0, limit),
    nextOffset: hasMore ? offset + limit : null,
  });
}

async function exportUserJourney(
  request: Request,
  env: Env,
  actor: StaffActor,
  format: "csv" | "pdf",
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as JourneyRequest | null;
  const access = await authorizeJourneyRequest(request, env, actor, body);
  const [summary, eventResult, user] = await Promise.all([
    loadJourneySummary(env, actor, access),
    loadAllJourneyEvents(env, access.eventFilter),
    loadAnalyticsUserIdentity(env, actor, access.userId),
  ]);
  const exportedAt = new Date().toISOString();
  const data: UserJourneyExportData = {
    user,
    range: access.range,
    ...summary,
    events: eventResult.events,
    eventCap: USER_JOURNEY_EXPORT_EVENT_CAP,
    truncated: eventResult.truncated,
    exportedAt,
  };
  const bytes = format === "csv" ? renderUserJourneyCsv(data) : renderUserJourneyPdf(data);
  if (userExportContainsForbidden(bytes)) {
    throw new HttpError(500, "Export refused to include sensitive content.");
  }

  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.analyticsJourneyExported,
    targetType: "user",
    targetId: access.userId,
    metadata: {
      format,
      reason: access.reason,
      from: access.range.from,
      to: access.range.to,
      returnedEvents: eventResult.events.length,
      truncated: eventResult.truncated,
    },
    requestId: actor.requestId,
  });

  const filename = `replayr-user-analytics-${exportedAt.slice(0, 10)}.${format}`;
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function authorizeJourneyRequest(
  request: Request,
  env: Env,
  actor: StaffActor,
  body: JourneyRequest | null,
): Promise<JourneyAccess> {
  const userId = requireUserId(body?.userId);
  const reveal = await verifyAnalyticsReveal(
    env,
    request.headers.get("x-analytics-reveal"),
    actor.userId,
    userId,
  );
  const range = resolveJourneyRange(body?.from, body?.to);
  const subjects = await analyticsSubjectsForErasure(env, userId);
  if (!subjects.some((subject) => subject.id === reveal.subjectId)) {
    throw new HttpError(403, "That journey reveal no longer matches the active analytics identity.");
  }
  const subjectFilter = subjects.map((subject) => subject.id).join(",");
  return {
    userId,
    range,
    reason: reveal.reason,
    eventFilter:
      `subject_id=in.(${subjectFilter})` +
      `&occurred_at=gte.${encodeURIComponent(range.from)}` +
      `&occurred_at=lte.${encodeURIComponent(range.to)}`,
  };
}

async function loadJourneySummary(
  env: Env,
  actor: StaffActor,
  access: JourneyAccess,
): Promise<Pick<UserJourneyExportData, "counts" | "observedActivity">> {
  const userId = access.userId;
  const createdRange = timestampRange("created_at", access.range);
  const joinedRange = timestampRange("joined_at", access.range);
  const acceptedRange = timestampRange("accepted_at", access.range);
  const [
    authUser,
    cloudClips,
    screenshots,
    messagesSent,
    conversations,
    foldersOwned,
    foldersShared,
    following,
    followers,
    storageRows,
    localClipsSaved,
    localClipsDeleted,
    localScreenshotsCreated,
    localScreenshotsDeleted,
  ] = await Promise.all([
    getAuthUser(env, actor.serviceKey, userId),
    serviceRestCount(env, `/clips?user_id=eq.${userId}&status=eq.ready&${createdRange}`),
    serviceRestCount(env, `/screenshots?user_id=eq.${userId}&status=eq.ready&${createdRange}`),
    serviceRestCount(env, `/messages?sender_id=eq.${userId}&${createdRange}`),
    serviceRestCount(env, `/conversation_members?user_id=eq.${userId}&${joinedRange}`),
    serviceRestCount(env, `/folders?owner_id=eq.${userId}&${createdRange}`),
    serviceRestCount(env, `/folder_members?user_id=eq.${userId}&${createdRange}`),
    serviceRestCount(env, `/follows?follower_id=eq.${userId}&status=eq.accepted&${acceptedRange}`),
    serviceRestCount(env, `/follows?following_id=eq.${userId}&status=eq.accepted&${acceptedRange}`),
    serviceRest<Storage[]>(
      env,
      "GET",
      `/user_storage?user_id=eq.${userId}&select=storage_used_bytes,storage_limit_bytes,plans(slug)&limit=1`,
    ),
    serviceRestCount(env, `/analytics_events?${access.eventFilter}&event_name=eq.clip.saved`),
    serviceRestCount(env, `/analytics_events?${access.eventFilter}&event_name=eq.clip.local_deleted`),
    serviceRestCount(env, `/analytics_events?${access.eventFilter}&event_name=eq.screenshot.local_created`),
    serviceRestCount(env, `/analytics_events?${access.eventFilter}&event_name=eq.screenshot.local_deleted`),
  ]);
  if (!authUser) throw new HttpError(404, "That account was not found.");
  const storage = storageRows[0];
  return {
    counts: {
      cloudClips,
      screenshots,
      messagesSent,
      conversations,
      foldersOwned,
      foldersShared,
      following,
      followers,
      storageUsedBytes: Number(storage?.storage_used_bytes ?? 0),
      storageLimitBytes: Number(storage?.storage_limit_bytes ?? 0),
      plan: relation(storage?.plans)?.slug ?? "free",
      accountCreatedAt: authUser.created_at ?? null,
    },
    observedActivity: {
      label: "Observed since instrumentation within the selected retention window",
      localClipsSaved,
      localClipsDeleted,
      localScreenshotsCreated,
      localScreenshotsDeleted,
    },
  };
}

export function timestampRange(
  column: "created_at" | "joined_at" | "accepted_at",
  range: { from: string; to: string },
): string {
  return `${column}=gte.${encodeURIComponent(range.from)}&${column}=lte.${encodeURIComponent(range.to)}`;
}

async function loadJourneyEventPage(
  env: Env,
  eventFilter: string,
  limit: number,
  offset: number,
): Promise<ExportJourneyEvent[]> {
  const rows = await serviceRest<JourneyEvent[]>(
    env,
    "GET",
    `/analytics_events?${eventFilter}&select=event_name,occurred_at,platform,properties&order=occurred_at.desc,id.desc&limit=${limit}&offset=${offset}`,
  );
  return rows.map((event) => ({
    eventName: event.event_name,
    occurredAt: event.occurred_at,
    platform: event.platform,
    properties: safeJourneyProperties(event.properties),
  }));
}

async function loadAllJourneyEvents(
  env: Env,
  eventFilter: string,
): Promise<{ events: ExportJourneyEvent[]; truncated: boolean }> {
  const events: ExportJourneyEvent[] = [];
  while (events.length <= USER_JOURNEY_EXPORT_EVENT_CAP) {
    const remaining = USER_JOURNEY_EXPORT_EVENT_CAP + 1 - events.length;
    const pageSize = Math.min(EXPORT_EVENT_PAGE, remaining);
    const page = await loadJourneyEventPage(env, eventFilter, pageSize, events.length);
    events.push(...page);
    if (page.length < pageSize) break;
  }
  return capJourneyEvents(events);
}

export function capJourneyEvents(
  events: ExportJourneyEvent[],
): { events: ExportJourneyEvent[]; truncated: boolean } {
  return {
    events: events.slice(0, USER_JOURNEY_EXPORT_EVENT_CAP),
    truncated: events.length > USER_JOURNEY_EXPORT_EVENT_CAP,
  };
}

async function loadAnalyticsUserIdentity(
  env: Env,
  actor: StaffActor,
  userId: string,
): Promise<UserJourneyExportData["user"]> {
  const [authUser, profiles] = await Promise.all([
    getAuthUser(env, actor.serviceKey, userId),
    serviceRest<Profile[]>(env, "GET", `/profiles?id=eq.${userId}&select=id,username,display_name&limit=1`),
  ]);
  if (!authUser) throw new HttpError(404, "That account was not found.");
  return {
    userId,
    email: authUser.email ?? null,
    username: profiles[0]?.username ?? null,
    displayName: profiles[0]?.display_name ?? null,
    createdAt: authUser.created_at ?? null,
  };
}

async function auditedJourneyAccess(
  request: Request,
  env: Env,
  actor: StaffActor,
  action: () => Promise<Response>,
): Promise<Response> {
  const body = (await request.clone().json().catch(() => null)) as { userId?: unknown } | null;
  const targetId = typeof body?.userId === "string" && UUID.test(body.userId) ? body.userId : null;
  try {
    return await action();
  } catch (caught) {
    await writeAuditLog(env, {
      actorUserId: actor.userId,
      actorType: "admin",
      action: AUDIT_ACTIONS.analyticsJourneyRevealDenied,
      targetType: targetId ? "user" : "analytics_user",
      targetId,
      metadata: { reason: caught instanceof HttpError ? caught.message : "Journey access failed" },
      requestId: actor.requestId,
    });
    throw caught;
  }
}

function safeSearch(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Search text is required.");
  const query = value.replace(/[^a-zA-Z0-9@._+\- ]/g, "").trim().slice(0, 80);
  if (query.length < 2) throw new HttpError(400, "Enter at least two characters.");
  return query;
}

function requireUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, "User id is invalid.");
  return value;
}

export function resolveJourneyRange(from: unknown, to: unknown): { from: string; to: string } {
  const end = typeof to === "string" ? new Date(to) : new Date();
  const start = typeof from === "string" ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new HttpError(400, "Journey dates are invalid.");
  }
  if (end.getTime() - start.getTime() > 30 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, "Journeys are limited to 30 days.");
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function integerWithin(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function safeJourneyProperties(
  value: Record<string, unknown> | null,
): Record<string, string | number | boolean | null> {
  const next: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      next[key] = item;
    } else if (typeof item === "string" && item.length <= 80) {
      next[key] = item;
    }
  }
  return next;
}

async function listAuthUsers(env: Env, serviceKey: string, perPage: number): Promise<AuthUser[]> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=${perPage}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new HttpError(502, "Could not search accounts.");
  const body = (await response.json()) as { users?: AuthUser[] };
  return body.users ?? [];
}

async function getAuthUser(env: Env, serviceKey: string, id: string): Promise<AuthUser | null> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError(502, "Could not load account.");
  return (await response.json()) as AuthUser;
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
