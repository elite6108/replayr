import { accountAccessBanActive } from "./accessBans";
import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import { clearUserAvatar } from "./avatars";
import type { Env } from "./env";
import { moderationReportEmail, sendReplayrEmail } from "./email";
import { HttpError, json } from "./http";
import { ownedScreenshotKey } from "./screenshotsCore";
import type { ReportReason, ReportTargetType } from "./social-types";
import { REPORT_REASONS, REPORT_TARGET_TYPES } from "./social-types";
import type { StaffActor } from "./staffAuth";
import {
  clearAccountGate,
  deleteR2Object,
  ownedObjectKey,
  requireR2,
  requireUser,
  serviceRest,
  serviceRestCount,
} from "./shared";
import { deleteBunnyAssetForClip } from "./watermark";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REPORT_SLA_MS = 24 * 60 * 60 * 1000;

const RESOLVE_ACTIONS = ["dismiss", "remove_content", "suspend_user", "remove_and_suspend"] as const;
type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

type ReportRow = {
  id: string;
  reporter_id: string;
  target_type: ReportTargetType;
  target_id: string;
  target_user_id: string | null;
  reason: ReportReason;
  details: string | null;
  status: "open" | "actioned" | "dismissed";
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
};

type PersonRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  suspended_at?: string | null;
};

const REPORT_SELECT =
  "id,reporter_id,target_type,target_id,target_user_id,reason,details,status,resolution,resolved_at,created_at";

export async function createContentReport(
  request: Request,
  env: Env,
  ctx?: { waitUntil(task: Promise<unknown>): void },
): Promise<Response> {
  const user = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as {
    targetType?: unknown;
    targetId?: unknown;
    reason?: unknown;
    details?: unknown;
  };
  const targetType = body.targetType;
  const targetId = body.targetId;
  const reason = body.reason;
  if (!isTargetType(targetType) || typeof targetId !== "string" || !UUID.test(targetId)) {
    throw new HttpError(400, "Choose something to report.");
  }
  if (!isReason(reason)) throw new HttpError(400, "Choose a reason.");
  const details = cleanText(body.details, 500, "Notes must be 500 characters or fewer.");
  const targetUserId = await lookupTargetUser(env, targetType, targetId, user.id);
  if (targetUserId === user.id) throw new HttpError(400, "You cannot report your own content.");

  let created: ReportRow | null = null;
  try {
    const rows = await serviceRest<ReportRow[]>(
      env,
      "POST",
      `/content_reports?select=${REPORT_SELECT}`,
      {
        reporter_id: user.id,
        target_type: targetType,
        target_id: targetId,
        target_user_id: targetUserId,
        reason,
        details,
      },
      "return=representation",
    );
    created = rows[0] ?? null;
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 409) {
      return json({ ok: true, alreadyReported: true });
    }
    throw caught;
  }
  if (!created) throw new HttpError(502, "Could not save that report.");

  const notify = notifySupport(env, created).catch((caught) => {
    console.error("moderation_report_email_failed", caught instanceof Error ? caught.message : "unknown");
  });
  if (ctx) ctx.waitUntil(notify);
  else await notify;
  return json({ ok: true, alreadyReported: false }, 201);
}

export async function listModerationReports(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status") || "open";
  if (status !== "open" && status !== "actioned" && status !== "dismissed" && status !== "all") {
    throw new HttpError(400, "That status is not valid.");
  }
  const page = pageOf(url);
  const statusFilter = status === "all" ? "" : `&status=eq.${status}`;
  const order = status === "open" ? "created_at.asc" : "created_at.desc";
  const [rows, total] = await Promise.all([
    serviceRest<ReportRow[]>(
      env,
      "GET",
      `/content_reports?select=${REPORT_SELECT}${statusFilter}&order=${order}&limit=${page.limit}&offset=${page.offset}`,
    ),
    serviceRestCount(env, `/content_reports?select=id${statusFilter}`),
  ]);
  const openTotal =
    status === "open" ? total : await serviceRestCount(env, "/content_reports?select=id&status=eq.open");
  const [people, previews] = await Promise.all([loadPeople(env, rows), loadPreviews(env, rows)]);
  const now = Date.now();
  return json({
    reports: rows.map((row) => presentReport(row, people, previews, now)),
    total,
    openTotal,
    page: page.page,
    limit: page.limit,
    slaHours: 24,
  });
}

export async function resolveModerationReport(
  request: Request,
  env: Env,
  actor: StaffActor,
  reportId: string,
): Promise<Response> {
  if (!UUID.test(reportId)) throw new HttpError(404, "That report was not found.");
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; note?: unknown };
  if (!isResolveAction(body.action)) throw new HttpError(400, "Choose how to resolve the report.");
  const note = cleanText(body.note, 500, "Notes must be 500 characters or fewer.");
  const rows = await serviceRest<ReportRow[]>(
    env,
    "GET",
    `/content_reports?id=eq.${reportId}&select=${REPORT_SELECT}`,
  );
  const report = rows[0];
  if (!report) throw new HttpError(404, "That report was not found.");
  if (report.status !== "open") throw new HttpError(409, "That report is already resolved.");

  const removes = body.action === "remove_content" || body.action === "remove_and_suspend";
  const suspends = body.action === "suspend_user" || body.action === "remove_and_suspend";
  if (suspends) {
    if (!report.target_user_id) throw new HttpError(400, "That report is not tied to an account.");
    if (report.target_user_id === actor.userId) throw new HttpError(400, "You cannot suspend your own account.");
  }
  if (removes) await removeReportedContent(env, report);
  if (suspends && report.target_user_id) await suspendAccount(env, report.target_user_id, note);

  const now = new Date().toISOString();
  const status = body.action === "dismiss" ? "dismissed" : "actioned";
  await serviceRest(env, "PATCH", `/content_reports?id=eq.${reportId}&status=eq.open`, {
    status,
    resolution: note,
    resolved_by: actor.userId,
    resolved_at: now,
  });
  const auditMetadata = {
    reportId: report.id,
    reason: report.reason,
    targetUserId: report.target_user_id,
  };
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: auditAction(body.action),
    targetType: report.target_type,
    targetId: report.target_id,
    requestId: actor.requestId,
    metadata: auditMetadata,
  });
  if (body.action === "remove_and_suspend") {
    await writeAuditLog(env, {
      actorUserId: actor.userId,
      actorType: "admin",
      action: AUDIT_ACTIONS.moderationUserSuspended,
      targetType: "profile",
      targetId: report.target_user_id,
      requestId: actor.requestId,
      metadata: auditMetadata,
    });
  }
  return json({ ok: true, status });
}

export async function unsuspendModerationUser(env: Env, actor: StaffActor, userId: string): Promise<Response> {
  if (!UUID.test(userId)) throw new HttpError(404, "That account was not found.");
  const rows = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/profiles?id=eq.${userId}&select=id`,
  );
  if (!rows[0]) throw new HttpError(404, "That account was not found.");
  if (await accountAccessBanActive(env, userId)) {
    throw new HttpError(409, "Lift the ban before restoring this account.");
  }
  await serviceRest(env, "PATCH", `/profiles?id=eq.${userId}`, {
    suspended_at: null,
    suspended_reason: null,
  });
  clearAccountGate(userId);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.moderationUserUnsuspended,
    targetType: "profile",
    targetId: userId,
    requestId: actor.requestId,
  });
  return json({ ok: true });
}

async function lookupTargetUser(
  env: Env,
  targetType: ReportTargetType,
  targetId: string,
  reporterId: string,
): Promise<string> {
  if (targetType === "profile") {
    const rows = await serviceRest<Array<{ id: string }>>(env, "GET", `/profiles?id=eq.${targetId}&select=id`);
    if (!rows[0]) throw new HttpError(404, "That content was not found.");
    return rows[0].id;
  }
  if (targetType === "clip") {
    const rows = await serviceRest<Array<{ user_id: string; status: string }>>(
      env,
      "GET",
      `/clips?id=eq.${targetId}&select=user_id,status`,
    );
    const row = rows[0];
    if (!row || row.status === "deleted") throw new HttpError(404, "That content was not found.");
    return row.user_id;
  }
  if (targetType === "comment") {
    const rows = await serviceRest<Array<{ user_id: string }>>(
      env,
      "GET",
      `/clip_comments?id=eq.${targetId}&select=user_id`,
    );
    if (!rows[0]) throw new HttpError(404, "That content was not found.");
    return rows[0].user_id;
  }
  if (targetType === "post") {
    const rows = await serviceRest<Array<{ user_id: string }>>(env, "GET", `/posts?id=eq.${targetId}&select=user_id`);
    if (!rows[0]) throw new HttpError(404, "That content was not found.");
    return rows[0].user_id;
  }
  if (targetType === "screenshot") {
    const rows = await serviceRest<Array<{ user_id: string; status: string }>>(
      env,
      "GET",
      `/screenshots?id=eq.${targetId}&select=user_id,status`,
    );
    const row = rows[0];
    if (!row || row.status === "deleted") throw new HttpError(404, "That content was not found.");
    return row.user_id;
  }
  const messages = await serviceRest<Array<{ sender_id: string; conversation_id: string }>>(
    env,
    "GET",
    `/messages?id=eq.${targetId}&select=sender_id,conversation_id`,
  );
  const message = messages[0];
  if (!message) throw new HttpError(404, "That content was not found.");
  const members = await serviceRest<Array<{ user_id: string }>>(
    env,
    "GET",
    `/conversation_members?conversation_id=eq.${message.conversation_id}&user_id=eq.${reporterId}&select=user_id&limit=1`,
  );
  if (!members[0]) throw new HttpError(404, "That content was not found.");
  return message.sender_id;
}

async function removeReportedContent(env: Env, report: ReportRow): Promise<void> {
  if (report.target_type === "clip") return removeClip(env, report.target_id);
  if (report.target_type === "screenshot") return removeScreenshot(env, report.target_id);
  if (report.target_type === "comment") {
    await serviceRest(env, "DELETE", `/clip_comments?id=eq.${report.target_id}`);
    return;
  }
  if (report.target_type === "post") {
    await serviceRest(env, "DELETE", `/posts?id=eq.${report.target_id}`);
    return;
  }
  if (report.target_type === "message") {
    await serviceRest(env, "PATCH", `/messages?id=eq.${report.target_id}`, {
      body: null,
      clip_id: null,
      removed_at: new Date().toISOString(),
    });
    return;
  }
  if (!report.target_user_id) throw new HttpError(400, "That profile could not be cleared.");
  await clearUserAvatar(env, report.target_user_id);
  await serviceRest(env, "PATCH", `/profiles?id=eq.${report.target_user_id}`, {
    display_name: "Player",
    bio: null,
  });
}

async function removeClip(env: Env, clipId: string): Promise<void> {
  const clips = await serviceRest<
    Array<{
      id: string;
      user_id: string;
      status: string;
      file_size_bytes: number | null;
      storage_key: string | null;
      thumbnail_key: string | null;
      watermark_processor_video_id: string | null;
    }>
  >(
    env,
    "GET",
    `/clips?id=eq.${clipId}&select=id,user_id,status,file_size_bytes,storage_key,thumbnail_key,watermark_processor_video_id`,
  );
  const clip = clips[0];
  if (!clip || clip.status === "deleted") return;
  if (clip.storage_key || clip.thumbnail_key) requireR2(env);
  if (ownedObjectKey(clip.user_id, clip.storage_key)) await deleteR2Object(env, clip.storage_key);
  if (ownedObjectKey(clip.user_id, clip.thumbnail_key)) await deleteR2Object(env, clip.thumbnail_key);
  await deleteBunnyAssetForClip(env, clip.watermark_processor_video_id);
  if (clip.status === "ready" && clip.file_size_bytes && clip.file_size_bytes > 0) {
    const storage = await serviceRest<Array<{ storage_used_bytes: number }>>(
      env,
      "GET",
      `/user_storage?user_id=eq.${clip.user_id}&select=storage_used_bytes`,
    );
    const used = Number(storage[0]?.storage_used_bytes ?? 0);
    await serviceRest(env, "PATCH", `/user_storage?user_id=eq.${clip.user_id}`, {
      storage_used_bytes: Math.max(0, used - clip.file_size_bytes),
      updated_at: new Date().toISOString(),
    });
  }
  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}`, {
    status: "deleted",
    storage_key: null,
    thumbnail_key: null,
    watermark_processor_video_id: null,
    watermark_variant_status: "none",
  });
  await serviceRest(env, "DELETE", `/upload_sessions?clip_id=eq.${clipId}`);
}

async function removeScreenshot(env: Env, screenshotId: string): Promise<void> {
  const rows = await serviceRest<
    Array<{ id: string; user_id: string; status: string; storage_key: string | null }>
  >(env, "GET", `/screenshots?id=eq.${screenshotId}&select=id,user_id,status,storage_key`);
  const row = rows[0];
  if (!row || row.status === "deleted") return;
  if (ownedScreenshotKey(row.user_id, row.storage_key)) {
    requireR2(env);
    await deleteR2Object(env, row.storage_key);
  }
  await serviceRest(env, "PATCH", `/screenshots?id=eq.${screenshotId}`, {
    status: "deleted",
    deleted_reason: "abuse",
    deleted_at: new Date().toISOString(),
    storage_key: null,
  });
}

async function suspendAccount(env: Env, userId: string, note: string | null): Promise<void> {
  await serviceRest(env, "PATCH", `/profiles?id=eq.${userId}`, {
    suspended_at: new Date().toISOString(),
    suspended_reason: (note || "Reported content").slice(0, 200),
  });
  clearAccountGate(userId);
}

async function notifySupport(env: Env, report: ReportRow): Promise<void> {
  const to = supportInbox(env);
  const origin = (env.PUBLIC_APP_URL || "https://www.replayr.tv").replace(/\/$/, "");
  const message = moderationReportEmail({
    targetType: report.target_type,
    reason: report.reason,
    queueUrl: `${origin}/admin/moderation`,
  });
  await sendReplayrEmail(env, {
    ...message,
    to,
    idempotencyKey: `moderation-report:${report.id}`,
  });
}

function supportInbox(env: Env): string {
  const configured = env.RESEND_REPLY_TO?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return configured || "support@replayr.tv";
}

async function loadPeople(env: Env, rows: ReportRow[]): Promise<Map<string, PersonRow>> {
  const ids = [...new Set(rows.flatMap((row) => [row.reporter_id, row.target_user_id].filter((id): id is string => Boolean(id))))];
  const people = new Map<string, PersonRow>();
  if (ids.length === 0) return people;
  const loaded = await serviceRest<PersonRow[]>(
    env,
    "GET",
    `/profiles?id=in.(${ids.join(",")})&select=id,username,display_name,suspended_at`,
  );
  for (const person of loaded) people.set(person.id, person);
  return people;
}

async function loadPreviews(
  env: Env,
  rows: ReportRow[],
): Promise<Map<string, { preview: string; path: string | null }>> {
  const previews = new Map<string, { preview: string; path: string | null }>();
  const ids = (type: ReportTargetType) => rows.filter((row) => row.target_type === type).map((row) => row.target_id);
  const [clips, comments, posts, profiles, messages, screenshots] = await Promise.all([
    fetchByIds<{ id: string; title: string | null; slug: string }>(env, "clips", ids("clip"), "id,title,slug"),
    fetchByIds<{ id: string; body: string }>(env, "clip_comments", ids("comment"), "id,body"),
    fetchByIds<{ id: string; body: string }>(env, "posts", ids("post"), "id,body"),
    fetchByIds<{ id: string; username: string | null; display_name: string | null; bio: string | null }>(
      env,
      "profiles",
      ids("profile"),
      "id,username,display_name,bio",
    ),
    fetchByIds<{ id: string; body: string | null; removed_at: string | null }>(
      env,
      "messages",
      ids("message"),
      "id,body,removed_at",
    ),
    fetchByIds<{ id: string; slug: string }>(env, "screenshots", ids("screenshot"), "id,slug"),
  ]);
  for (const row of clips) {
    previews.set(`clip:${row.id}`, {
      preview: clipPreview(row.title),
      path: `/c/${row.slug}`,
    });
  }
  for (const row of comments) previews.set(`comment:${row.id}`, { preview: snippet(row.body), path: null });
  for (const row of posts) previews.set(`post:${row.id}`, { preview: snippet(row.body), path: null });
  for (const row of profiles) {
    const handle = row.username ? `@${row.username}` : "Profile";
    const bits = [handle, row.display_name, row.bio].filter(Boolean);
    previews.set(`profile:${row.id}`, {
      preview: snippet(bits.join(" · ")),
      path: row.username ? `/u/${row.username}` : null,
    });
  }
  for (const row of messages) {
    previews.set(`message:${row.id}`, {
      preview: row.removed_at ? "Message removed" : snippet(row.body || "Sent a clip"),
      path: null,
    });
  }
  for (const row of screenshots) {
    previews.set(`screenshot:${row.id}`, { preview: `Screenshot ${row.slug}`, path: `/s/${row.slug}` });
  }
  return previews;
}

async function fetchByIds<T extends { id: string }>(env: Env, table: string, ids: string[], select: string): Promise<T[]> {
  const unique = [...new Set(ids)].filter((id) => UUID.test(id));
  if (unique.length === 0) return [];
  return serviceRest<T[]>(env, "GET", `/${table}?id=in.(${unique.join(",")})&select=${select}`);
}

function presentReport(
  row: ReportRow,
  people: Map<string, PersonRow>,
  previews: Map<string, { preview: string; path: string | null }>,
  now: number,
) {
  const ageMs = Math.max(0, now - Date.parse(row.created_at));
  const preview = previews.get(`${row.target_type}:${row.target_id}`);
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    details: row.details,
    createdAt: row.created_at,
    ageHours: Math.floor(ageMs / (60 * 60 * 1000)),
    overdue: row.status === "open" && ageMs >= REPORT_SLA_MS,
    targetType: row.target_type,
    targetId: row.target_id,
    preview: preview?.preview ?? "Content is no longer available.",
    targetPath: preview?.path ?? null,
    reporter: presentPerson(people.get(row.reporter_id), row.reporter_id),
    targetUser: row.target_user_id ? presentPerson(people.get(row.target_user_id), row.target_user_id) : null,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
  };
}

function presentPerson(person: PersonRow | undefined, id: string) {
  return {
    id,
    username: person?.username ?? null,
    displayName: person?.display_name || person?.username || "Player",
    suspended: Boolean(person?.suspended_at),
  };
}

function snippet(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function clipPreview(title: string | null): string {
  const text = title?.trim();
  return text ? snippet(text) : "Untitled clip";
}

function cleanText(value: unknown, max: number, tooLong: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "That note is not valid.");
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, tooLong);
  return text;
}

function pageOf(url: URL) {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)) || 1);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 30)) || 30));
  return { page, limit, offset: (page - 1) * limit };
}

function isTargetType(value: unknown): value is ReportTargetType {
  return typeof value === "string" && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

function isReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

function isResolveAction(value: unknown): value is ResolveAction {
  return typeof value === "string" && (RESOLVE_ACTIONS as readonly string[]).includes(value);
}

function auditAction(action: ResolveAction): string {
  if (action === "dismiss") return AUDIT_ACTIONS.moderationReportDismissed;
  if (action === "suspend_user") return AUDIT_ACTIONS.moderationUserSuspended;
  return AUDIT_ACTIONS.moderationContentRemoved;
}
