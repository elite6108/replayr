import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import type { StaffActor } from "./staffAuth";
import { clearAccountGate, serviceRest } from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IP_CACHE_MS = 15_000;

const BANNED_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replayr</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10141c;color:#e8edf5;font:16px/1.5 system-ui,sans-serif}
  main{max-width:28rem;padding:24px}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{margin:0;color:#b7c0ce}
</style>
<main>
  <h1>Replayr is not available here</h1>
  <p>This network is blocked.</p>
</main>`;

type BanKind = "account" | "ip";

type BanRow = {
  id: string;
  kind: BanKind;
  subject: string;
  reason: string;
  created_at: string;
};

type ProfileLabel = {
  id: string;
  username: string | null;
  display_name: string | null;
  suspended_at?: string | null;
};

export type AccessBan = {
  id: string;
  kind: BanKind;
  subject: string;
  label: string;
  reason: string;
  createdAt: string;
};

let ipCache: { expiresAt: number; ips: Set<string> } | null = null;

export function clearIpBanCache(): void {
  ipCache = null;
}

/** Public IP only. Loopback, unspecified, and non-canonical forms are rejected. */
export function normalizeBanIp(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (!value || /[\s/%,]/.test(value)) return null;
  if (value.includes(".")) return normalizeIpv4(value);
  if (value.includes(":")) return normalizeIpv6(value);
  return null;
}

/**
 * Cloudflare overwrites CF-Connecting-IP, so a client cannot spoof it.
 * X-Forwarded-For is used only when that header is absent (local wrangler).
 */
export function requestClientIp(request: Request): string | null {
  const cloudflare = request.headers.get("cf-connecting-ip");
  if (cloudflare) return normalizeBanIp(cloudflare);
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return normalizeBanIp(forwarded.split(",")[0] ?? "");
}

export function bannedNetworkResponse(request: Request, url: URL): Response {
  const accept = request.headers.get("accept") || "";
  const api = url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/");
  if (!api && accept.includes("text/html")) {
    return new Response(BANNED_HTML, {
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
      },
    });
  }
  return json({ error: "Replayr is not available from this network.", code: "ip_banned" }, 403);
}

export async function rejectBannedNetwork(request: Request, env: Env, url: URL): Promise<Response | null> {
  const ip = requestClientIp(request);
  if (!ip || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const ips = await activeBannedIps(env);
    return ips.has(ip) ? bannedNetworkResponse(request, url) : null;
  } catch (caught) {
    console.error("ip ban lookup failed", caught instanceof Error ? caught.message : "unknown");
    return null;
  }
}

export async function accountAccessBanActive(env: Env, userId: string): Promise<boolean> {
  const rows = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/access_bans?kind=eq.account&subject=eq.${userId}&lifted_at=is.null&select=id&limit=1`,
  );
  return Boolean(rows[0]);
}

export async function handleAccessBanAdmin(
  request: Request,
  env: Env,
  url: URL,
  staff: StaffActor,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/v1/admin/bans" && request.method === "GET") return listBans(env);
  if (path === "/v1/admin/bans" && request.method === "POST") return createBan(request, env, staff);
  const lift = path.match(/^\/v1\/admin\/bans\/([^/]+)\/lift$/);
  if (lift?.[1] && request.method === "POST") return liftBan(env, staff, lift[1]);
  const restore = path.match(/^\/v1\/admin\/bans\/account\/([^/]+)\/restore$/);
  if (restore?.[1] && request.method === "POST") return restoreAccount(env, staff, restore[1]);
  return null;
}

async function listBans(env: Env): Promise<Response> {
  const rows = await serviceRest<BanRow[]>(
    env,
    "GET",
    "/access_bans?lifted_at=is.null&select=id,kind,subject,reason,created_at&order=created_at.desc&limit=100",
  );
  const labels = await accountLabels(env, rows);
  return json({ bans: rows.map((row) => presentBan(row, labels)) });
}

async function createBan(request: Request, env: Env, staff: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { kind?: unknown; userId?: unknown; ip?: unknown; reason?: unknown } | null;
  const reason = cleanReason(body?.reason);
  if (body?.kind === "account") {
    return banAccount(env, staff, body.userId, reason);
  }
  if (body?.kind === "ip") {
    return banIp(request, env, staff, body.ip, reason);
  }
  throw new HttpError(400, "Choose an account or an IP address.");
}

async function banAccount(env: Env, staff: StaffActor, userId: unknown, reason: string): Promise<Response> {
  const id = requiredUserId(userId);
  await assertCanChangeAccount(env, staff, id);
  const profile = await loadProfile(env, id);
  if (!profile) throw new HttpError(404, "That account was not found.");
  const existing = await accountAccessBanActive(env, id);
  if (existing) throw new HttpError(409, "That account is already banned.");
  await serviceRest(env, "PATCH", `/profiles?id=eq.${id}`, {
    suspended_at: new Date().toISOString(),
    suspended_reason: reason,
  });
  clearAccountGate(id);
  const row = await insertBan(env, staff, "account", id, reason);
  await auditBan(env, staff, "account", id, reason, false);
  return json({ ban: presentBan(row, new Map([[id, profile]])) });
}

async function banIp(request: Request, env: Env, staff: StaffActor, raw: unknown, reason: string): Promise<Response> {
  if (typeof raw !== "string") throw new HttpError(400, "Enter a public IP address.");
  const ip = normalizeBanIp(raw);
  if (!ip) throw new HttpError(400, "Enter a public IP address.");
  if (ip === requestClientIp(request)) throw new HttpError(403, "You cannot ban the network you are using.");
  const rows = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/access_bans?kind=eq.ip&subject=eq.${encodeURIComponent(ip)}&lifted_at=is.null&select=id&limit=1`,
  );
  if (rows[0]) throw new HttpError(409, "That IP address is already banned.");
  const row = await insertBan(env, staff, "ip", ip, reason);
  clearIpBanCache();
  await auditBan(env, staff, "ip", ip, reason, false);
  return json({ ban: presentBan(row, new Map()) });
}

async function liftBan(env: Env, staff: StaffActor, banId: string): Promise<Response> {
  if (!UUID.test(banId)) throw new HttpError(404, "That ban was not found.");
  const rows = await serviceRest<BanRow[]>(
    env,
    "GET",
    `/access_bans?id=eq.${banId}&lifted_at=is.null&select=id,kind,subject,reason,created_at&limit=1`,
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "That ban was not found.");
  if (row.kind === "account") await assertCanChangeAccount(env, staff, row.subject);
  await markLifted(env, staff, row.id);
  if (row.kind === "account") await clearSuspension(env, row.subject);
  if (row.kind === "ip") clearIpBanCache();
  await auditBan(env, staff, row.kind, row.subject, row.reason, true);
  return json({ ok: true });
}

async function restoreAccount(env: Env, staff: StaffActor, userId: string): Promise<Response> {
  const id = requiredUserId(userId);
  await assertCanChangeAccount(env, staff, id);
  const profile = await loadProfile(env, id);
  if (!profile) throw new HttpError(404, "That account was not found.");
  const rows = await serviceRest<BanRow[]>(
    env,
    "GET",
    `/access_bans?kind=eq.account&subject=eq.${id}&lifted_at=is.null&select=id,kind,subject,reason,created_at&limit=1`,
  );
  const row = rows[0];
  if (!row && !profile.suspended_at) throw new HttpError(404, "That account is not banned.");
  if (row) await markLifted(env, staff, row.id);
  await clearSuspension(env, id);
  await auditBan(env, staff, "account", id, row?.reason ?? "", true);
  return json({ ok: true });
}

async function activeBannedIps(env: Env): Promise<Set<string>> {
  if (ipCache && ipCache.expiresAt > Date.now()) return ipCache.ips;
  const ips = new Set<string>();
  for (let offset = 0; offset < 2_000; offset += 500) {
    const rows = await serviceRest<Array<{ subject: string }>>(
      env,
      "GET",
      `/access_bans?kind=eq.ip&lifted_at=is.null&select=subject&order=created_at.desc&limit=500&offset=${offset}`,
    );
    for (const row of rows) ips.add(row.subject);
    if (rows.length < 500) break;
  }
  ipCache = { expiresAt: Date.now() + IP_CACHE_MS, ips };
  return ips;
}

async function insertBan(env: Env, staff: StaffActor, kind: BanKind, subject: string, reason: string): Promise<BanRow> {
  try {
    const rows = await serviceRest<BanRow[]>(
      env,
      "POST",
      "/access_bans",
      { kind, subject, reason, created_by: staff.userId },
      "return=representation",
    );
    const row = rows[0];
    if (!row) throw new HttpError(502, "Could not save that ban.");
    return row;
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 409) {
      throw new HttpError(409, kind === "account" ? "That account is already banned." : "That IP address is already banned.");
    }
    throw caught;
  }
}

async function markLifted(env: Env, staff: StaffActor, banId: string): Promise<void> {
  await serviceRest(env, "PATCH", `/access_bans?id=eq.${banId}&lifted_at=is.null`, {
    lifted_at: new Date().toISOString(),
    lifted_by: staff.userId,
  });
}

async function clearSuspension(env: Env, userId: string): Promise<void> {
  await serviceRest(env, "PATCH", `/profiles?id=eq.${userId}`, {
    suspended_at: null,
    suspended_reason: null,
  });
  clearAccountGate(userId);
}

async function assertCanChangeAccount(env: Env, staff: StaffActor, userId: string): Promise<void> {
  if (userId === staff.userId) throw new HttpError(403, "You cannot change a ban on your own account.");
  if (!staff.isSuperAdmin && (await targetIsSuperAdmin(env, userId))) {
    throw new HttpError(403, "Only a Super Admin can change a Super Admin ban.");
  }
}

async function targetIsSuperAdmin(env: Env, userId: string): Promise<boolean> {
  const rows = await serviceRest<unknown[]>(
    env,
    "GET",
    `/staff_members?user_id=eq.${userId}&status=eq.active&select=staff_role_assignments(staff_roles(is_super_admin,archived_at))&limit=1`,
  );
  return rows.some(embedsSuperAdmin);
}

function embedsSuperAdmin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(embedsSuperAdmin);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.is_super_admin === true) return row.archived_at == null;
  return Object.values(row).some(embedsSuperAdmin);
}

async function loadProfile(env: Env, userId: string): Promise<ProfileLabel | null> {
  const rows = await serviceRest<ProfileLabel[]>(
    env,
    "GET",
    `/profiles?id=eq.${userId}&select=id,username,display_name,suspended_at&limit=1`,
  );
  return rows[0] ?? null;
}

async function accountLabels(env: Env, rows: BanRow[]): Promise<Map<string, ProfileLabel>> {
  const ids = rows.filter((row) => row.kind === "account" && UUID.test(row.subject)).map((row) => row.subject);
  if (!ids.length) return new Map();
  const profiles = await serviceRest<ProfileLabel[]>(
    env,
    "GET",
    `/profiles?id=in.(${ids.join(",")})&select=id,username,display_name`,
  );
  return new Map(profiles.map((profile) => [profile.id, profile]));
}

function presentBan(row: BanRow, labels: Map<string, ProfileLabel>): AccessBan {
  const profile = row.kind === "account" ? labels.get(row.subject) : undefined;
  const name = profile?.username ? `@${profile.username}` : profile?.display_name || row.subject;
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    label: name,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

async function auditBan(env: Env, staff: StaffActor, kind: BanKind, subject: string, reason: string, lifted: boolean): Promise<void> {
  const action = kind === "account"
    ? lifted ? AUDIT_ACTIONS.accessAccountUnbanned : AUDIT_ACTIONS.accessAccountBanned
    : lifted ? AUDIT_ACTIONS.accessIpUnbanned : AUDIT_ACTIONS.accessIpBanned;
  await writeAuditLog(env, {
    actorUserId: staff.userId,
    actorType: "admin",
    action,
    targetType: kind === "account" ? "profile" : "ip",
    targetId: subject,
    requestId: staff.requestId,
    metadata: reason ? { reason } : undefined,
  });
}

function requiredUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, "Account id is invalid.");
  return value;
}

function cleanReason(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "A reason is required.");
  const reason = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (reason.length < 1 || reason.length > 200) throw new HttpError(400, "Reason must be 1-200 characters.");
  return reason;
}

function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  if (octets[0] === 0 || octets[0] === 127 || octets.every((octet) => octet === 255)) return null;
  return octets.join(".");
}

function normalizeIpv6(value: string): string | null {
  if (!/^[0-9a-f:]+$/.test(value) || value.includes(":::") || value.split("::").length > 2) return null;
  try {
    const host = new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "::" || host === "::1") return null;
    return host;
  } catch {
    return null;
  }
}
