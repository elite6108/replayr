import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireServiceRole, requireUser } from "./shared";
import { AUDIT_ACTIONS, writeAuditLog } from "./audit";

export type AnalyticsConsent = "unset" | "allowed" | "denied";

type ConsentCacheEntry = { consent: AnalyticsConsent; expiresAt: number };
const consentCache = new Map<string, ConsentCacheEntry>();
const CONSENT_CACHE_MS = 60_000;
const SUBJECT_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export type AnalyticsSubject = {
  id: string;
  keyVersion: number;
};

export type AnalyticsReveal = {
  version: 1;
  staffUserId: string;
  targetUserId: string;
  subjectId: string;
  subjectKeyVersion: number;
  reason: string;
  issuedAt: number;
  expiresAt: number;
};

export async function handleAnalyticsConsent(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (request.method === "GET") {
    return json({ consent: await analyticsConsentForUser(env, user.id) });
  }
  if (request.method !== "PATCH") throw new HttpError(405, "Method not allowed.");
  const body = (await request.json().catch(() => null)) as { consent?: unknown } | null;
  if (body?.consent !== "allowed" && body?.consent !== "denied") {
    throw new HttpError(400, "consent must be allowed or denied.");
  }
  const key = requireServiceRole(env);
  const now = new Date().toISOString();
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/user_analytics_preferences?on_conflict=user_id`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      user_id: user.id,
      consent: body.consent,
      consented_at: body.consent === "allowed" ? now : null,
      updated_at: now,
    }),
  });
  if (!response.ok) throw new HttpError(502, "Could not update analytics privacy.");
  if (body.consent === "denied") {
    await eraseAnalyticsForUser(env, user.id);
    await writeAuditLog(env, {
      actorUserId: user.id,
      actorType: "user",
      action: AUDIT_ACTIONS.analyticsUserErased,
      targetType: "user",
      targetId: user.id,
      metadata: { reason: "consent_withdrawn" },
    });
  }
  consentCache.set(user.id, { consent: body.consent, expiresAt: Date.now() + CONSENT_CACHE_MS });
  return json({ consent: body.consent });
}

export async function analyticsConsentForUser(env: Env, userId: string): Promise<AnalyticsConsent> {
  const cached = consentCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.consent;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return "unset";
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_analytics_preferences?user_id=eq.${encodeURIComponent(userId)}&select=consent&limit=1`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (!response.ok) return "unset";
  const rows = (await response.json().catch(() => [])) as Array<{ consent?: AnalyticsConsent }>;
  const consent = rows[0]?.consent;
  const next: AnalyticsConsent = consent === "allowed" || consent === "denied" ? consent : "unset";
  consentCache.set(userId, { consent: next, expiresAt: Date.now() + CONSENT_CACHE_MS });
  return next;
}

export async function analyticsSubjectForUser(env: Env, userId: string): Promise<AnalyticsSubject | null> {
  const key = env.ANALYTICS_SUBJECT_KEY?.trim();
  const version = Number(env.ANALYTICS_SUBJECT_KEY_VERSION || "1");
  if (!key || key.length < 32 || !Number.isInteger(version) || version < 1) return null;
  return {
    id: await hmacHex(key, `user:${userId}`),
    keyVersion: version,
  };
}

export async function analyticsSubjectsForErasure(env: Env, userId: string): Promise<AnalyticsSubject[]> {
  const current = await analyticsSubjectForUser(env, userId);
  const subjects = current ? [current] : [];
  const previous = env.ANALYTICS_SUBJECT_PREVIOUS_KEY?.trim();
  const currentVersion = current?.keyVersion ?? Number(env.ANALYTICS_SUBJECT_KEY_VERSION || "1");
  if (previous && previous.length >= 32 && currentVersion > 1) {
    subjects.push({
      id: await hmacHex(previous, `user:${userId}`),
      keyVersion: currentVersion - 1,
    });
  }
  return subjects;
}

export async function purgeExpiredAnalyticsEvents(env: Env): Promise<number> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return 0;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/purge_expired_analytics_events`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_before: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
  });
  if (!response.ok) throw new HttpError(502, "Could not enforce analytics retention.");
  const value = (await response.json().catch(() => 0)) as number | null;
  return Number(value ?? 0);
}

export async function eraseAnalyticsForUser(env: Env, userId: string): Promise<void> {
  const key = requireServiceRole(env);
  const subjects = await analyticsSubjectsForErasure(env, userId);
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    prefer: "return=minimal",
  };
  const deletes: Array<{ table: string; filter: string }> = [
    { table: "analytics_events", filter: `user_id=eq.${encodeURIComponent(userId)}` },
    { table: "analytics_user_daily_activity", filter: `user_id=eq.${encodeURIComponent(userId)}` },
    { table: "analytics_user_milestones", filter: `user_id=eq.${encodeURIComponent(userId)}` },
    { table: "analytics_user_game_first", filter: `user_id=eq.${encodeURIComponent(userId)}` },
    { table: "analytics_user_paid_first", filter: `user_id=eq.${encodeURIComponent(userId)}` },
    { table: "user_acquisition", filter: `user_id=eq.${encodeURIComponent(userId)}` },
  ];
  for (const subject of subjects) {
    deletes.push({
      table: "analytics_events",
      filter: `subject_id=eq.${encodeURIComponent(subject.id)}`,
    });
  }
  for (const item of deletes) {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${item.table}?${item.filter}`, {
      method: "DELETE",
      headers,
    });
    if (!response.ok) throw new HttpError(502, "Could not erase account analytics.");
  }
  consentCache.delete(userId);
}

export async function hashAnonymousAnalyticsId(env: Env, anonymousId: string | null | undefined): Promise<string | null> {
  if (!anonymousId) return null;
  const key = env.ANALYTICS_SUBJECT_KEY?.trim();
  if (!key || key.length < 32) return null;
  return hmacHex(key, `anonymous:${anonymousId}`);
}

export function roundedAnalyticsTime(value: string | undefined, now = new Date()): string {
  const parsed = value ? new Date(value) : now;
  if (Number.isNaN(parsed.getTime())) return roundedAnalyticsTime(undefined, now);
  const maxSkewMs = 24 * 60 * 60 * 1000;
  if (Math.abs(parsed.getTime() - now.getTime()) > maxSkewMs) {
    throw new HttpError(400, "occurredAt must be within 24 hours.");
  }
  const fiveMinutes = 5 * 60 * 1000;
  return new Date(Math.floor(parsed.getTime() / fiveMinutes) * fiveMinutes).toISOString();
}

export function requireStaffAal2(request: Request): void {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  const payload = decodeJwtPayload(token);
  if (payload?.aal !== "aal2") {
    throw new HttpError(403, "Multi-factor authentication is required to view a named journey.");
  }
}

export async function createAnalyticsReveal(
  env: Env,
  input: Omit<AnalyticsReveal, "version" | "issuedAt" | "expiresAt">,
): Promise<{ token: string; reveal: AnalyticsReveal }> {
  const key = revealSigningKey(env);
  const issuedAt = Math.floor(Date.now() / 1000);
  const reveal: AnalyticsReveal = {
    version: 1,
    ...input,
    issuedAt,
    expiresAt: issuedAt + 10 * 60,
  };
  const payload = base64UrlEncode(JSON.stringify(reveal));
  const signature = await hmacBase64Url(key, `reveal:${payload}`);
  return { token: `${payload}.${signature}`, reveal };
}

export async function verifyAnalyticsReveal(
  env: Env,
  token: string | null,
  staffUserId: string,
  targetUserId: string,
): Promise<AnalyticsReveal> {
  const [payload, signature, extra] = (token || "").split(".");
  if (!payload || !signature || extra) throw new HttpError(403, "A valid journey reveal is required.");
  const expected = await hmacBase64Url(revealSigningKey(env), `reveal:${payload}`);
  if (!constantTimeEqual(signature, expected)) throw new HttpError(403, "That journey reveal is invalid.");
  let reveal: AnalyticsReveal;
  try {
    reveal = JSON.parse(base64UrlDecode(payload)) as AnalyticsReveal;
  } catch {
    throw new HttpError(403, "That journey reveal is invalid.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    reveal.version !== 1 ||
    reveal.staffUserId !== staffUserId ||
    reveal.targetUserId !== targetUserId ||
    !SUBJECT_HEX.test(reveal.subjectId) ||
    reveal.expiresAt <= now ||
    reveal.issuedAt > now + 30
  ) {
    throw new HttpError(403, "That journey reveal is invalid or expired.");
  }
  return reveal;
}

export function sanitizeRevealReason(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "A reason is required.");
  const reason = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (reason.length < 8 || reason.length > 160) {
    throw new HttpError(400, "Reason must be between 8 and 160 characters.");
  }
  return reason;
}

function revealSigningKey(env: Env): string {
  const key = env.ANALYTICS_SUBJECT_KEY?.trim();
  if (!key || key.length < 32) throw new HttpError(503, "Secure journey analytics is not configured.");
  return key;
}

async function hmacHex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function base64UrlEncode(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
