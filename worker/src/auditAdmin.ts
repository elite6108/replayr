import { parseAdminAnalyticsQuery } from "./analyticsAdmin";
import { auditActionLabel } from "./audit";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest } from "./shared";

const ACTOR_TYPES = new Set(["user", "admin", "system"]);
const PAGE_SIZE = 50;

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
};

export async function listAdminAudit(env: Env, url: URL): Promise<Response> {
  const parsed = parseAdminAnalyticsQuery(url);
  const from = parsed.from;
  const to = parsed.to;
  const actor = (url.searchParams.get("actor") || "").trim();
  const actorType = (url.searchParams.get("actorType") || "").trim();
  const action = (url.searchParams.get("action") || "").trim();
  const targetType = (url.searchParams.get("targetType") || "").trim();
  const targetId = (url.searchParams.get("targetId") || "").trim();
  const search = (url.searchParams.get("search") || url.searchParams.get("q") || "").trim().slice(0, 80);
  const cursor = (url.searchParams.get("cursor") || "").trim();
  if (actorType && !ACTOR_TYPES.has(actorType)) throw new HttpError(400, "actorType must be user, admin, or system.");

  const filters = [
    "select=id,actor_user_id,actor_type,action,target_type,target_id,metadata,request_id,created_at",
    `created_at=gte.${from}T00:00:00.000Z`,
    `created_at=lt.${to}T00:00:00.000Z`,
    "order=created_at.desc,id.desc",
  ];
  if (actor) filters.push(`actor_user_id=eq.${actor}`);
  if (actorType) filters.push(`actor_type=eq.${actorType}`);
  if (action) filters.push(`action=eq.${action}`);
  if (targetType) filters.push(`target_type=eq.${targetType}`);
  if (targetId) filters.push(`target_id=eq.${targetId}`);
  if (search) filters.push(`action=ilike.*${search.replace(/[,()]/g, "")}*`);
  if (cursor) filters.push(`created_at=lt.${cursor}`);

  const rows = await serviceRest<AuditRow[]>(
    env,
    "GET",
    `/audit_log?${filters.join("&")}&limit=${PAGE_SIZE + 1}`,
  );
  const page = rows.slice(0, PAGE_SIZE);
  const next = rows[PAGE_SIZE]?.created_at ?? null;
  return json({
    range: { from, to },
    items: page.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      actorUserId: row.actor_user_id,
      actorType: row.actor_type,
      action: row.action,
      actionLabel: auditActionLabel(row.action),
      targetType: row.target_type,
      targetId: row.target_id,
      targetHref: targetHref(row.target_type, row.target_id),
      metadata: row.metadata ?? {},
      requestId: row.request_id,
    })),
    nextCursor: next,
    limit: PAGE_SIZE,
  });
}

function targetHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === "user") return `/admin/users`;
  if (type === "clip") return `/admin/clips`;
  return null;
}
