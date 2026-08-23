import { HttpError, json } from "./http";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const SURFACES = new Set(["desktop", "web", "mobile", "worker"]);
const LEVELS = new Set(["error", "crash"]);
const recentByIp = new Map<string, number[]>();

interface ErrorRow {
  fingerprint: string;
  surface: string;
  level: string;
  message: string;
  stack: string | null;
  release: string | null;
  path: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  sample_user_id: string | null;
}

export async function ingestClientError(request: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Error ingest is not configured.");
  }
  if (!allowIngest(request)) {
    throw new HttpError(429, "Slow down.");
  }
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const surface = asEnum(payload.surface, SURFACES);
  const level = asEnum(payload.level, LEVELS) ?? "error";
  const message = scrub(clip(asString(payload.message), 500));
  if (!surface || !message) {
    throw new HttpError(400, "surface and message are required.");
  }
  const stack = scrub(clip(asString(payload.stack), 4000)) || null;
  const release = clip(asString(payload.release), 40) || null;
  const path = clip(asString(payload.path), 160) || null;
  const userId = await optionalUserId(request, env);
  const fingerprint = await hashFingerprint([surface, level, normalizeMessage(message), firstStackLine(stack)]);
  await callIngest(env, {
    p_fingerprint: fingerprint,
    p_surface: surface,
    p_level: level,
    p_message: message,
    p_stack: stack,
    p_release: release,
    p_path: path,
    p_user_id: userId,
  });
  return json({ ok: true }, 202);
}

export async function recordWorkerError(env: Env, message: string, path?: string): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  if (path?.startsWith("/v1/errors") || message.includes("error_events") || message.includes("ingest_error_event")) {
    return;
  }
  try {
    const cleaned = scrub(clip(message, 500)) || "Worker failed.";
    const fingerprint = await hashFingerprint(["worker", "error", normalizeMessage(cleaned), path ?? ""]);
    await callIngest(env, {
      p_fingerprint: fingerprint,
      p_surface: "worker",
      p_level: "error",
      p_message: cleaned,
      p_stack: null,
      p_release: null,
      p_path: clip(path ?? "", 160) || null,
      p_user_id: null,
    });
  } catch {
    /* never fail the user request because telemetry failed */
  }
}

export async function listAdminErrors(
  env: Env,
  serviceKey: string,
  url: URL,
): Promise<Response> {
  const surface = asEnum(url.searchParams.get("surface"), SURFACES);
  const level = asEnum(url.searchParams.get("level"), LEVELS);
  const openOnly = url.searchParams.get("resolved") !== "all";
  const query = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = 40;
  const from = (page - 1) * limit;
  const filters = ["select=fingerprint,surface,level,message,stack,release,path,count,first_seen_at,last_seen_at,resolved_at"];
  if (surface) filters.push(`surface=eq.${surface}`);
  if (level) filters.push(`level=eq.${level}`);
  if (openOnly) filters.push("resolved_at=is.null");
  if (query) filters.push(`message=ilike.*${query.replace(/[,()]/g, "")}*`);
  filters.push("order=last_seen_at.desc");
  const path = `/error_events?${filters.join("&")}`;
  const { rows, count } = await restPage<ErrorRow>(env, serviceKey, path, from, from + limit - 1);
  return json({
    errors: rows.map((row) => ({
      fingerprint: row.fingerprint,
      surface: row.surface,
      level: row.level,
      message: row.message,
      stack: row.stack,
      release: row.release,
      path: row.path,
      count: row.count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
    })),
    total: count ?? rows.length,
    page,
    limit,
  });
}

export async function resolveAdminError(
  env: Env,
  serviceKey: string,
  fingerprint: string,
  resolved: boolean,
): Promise<Response> {
  if (!/^[a-f0-9]{16,64}$/i.test(fingerprint)) {
    throw new HttpError(404, "That error was not found.");
  }
  await rest(env, serviceKey, "PATCH", `/error_events?fingerprint=eq.${fingerprint}`, {
    resolved_at: resolved ? new Date().toISOString() : null,
  });
  return json({ ok: true, resolved });
}

export async function openErrorCount(env: Env, serviceKey: string): Promise<{ open: number; last24h: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [open, last24h] = await Promise.all([
    restCount(env, serviceKey, "/error_events?resolved_at=is.null&select=fingerprint"),
    restCount(env, serviceKey, `/error_events?last_seen_at=gte.${since}&select=fingerprint`),
  ]);
  return { open, last24h };
}

async function callIngest(
  env: Env,
  body: {
    p_fingerprint: string;
    p_surface: string;
    p_level: string;
    p_message: string;
    p_stack: string | null;
    p_release: string | null;
    p_path: string | null;
    p_user_id: string | null;
  },
): Promise<void> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ingest_error_event`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function optionalUserId(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as { id?: string };
    return user.id ?? null;
  } catch {
    return null;
  }
}

function allowIngest(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const now = Date.now();
  const windowMs = 60_000;
  const next = (recentByIp.get(ip) ?? []).filter((at) => now - at < windowMs);
  if (next.length >= 20) {
    recentByIp.set(ip, next);
    return false;
  }
  next.push(now);
  recentByIp.set(ip, next);
  return true;
}

async function hashFingerprint(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function normalizeMessage(message: string): string {
  return message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function firstStackLine(stack: string | null): string {
  if (!stack) return "";
  return stack.split(/\r?\n/).find((line) => line.includes(".ts") || line.includes(".tsx") || line.includes(".js")) ?? "";
}

function scrub(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, "bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[jwt]")
    .replace(/sb_[a-z0-9_]+/gi, "[redacted]");
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

async function restPage<T>(
  env: Env,
  key: string,
  path: string,
  from: number,
  to: number,
): Promise<{ rows: T[]; count: number | null }> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
      range: `${from}-${to}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(502, "Could not load error logs.");
  const total = response.headers.get("content-range")?.split("/")[1];
  return {
    rows: text ? (JSON.parse(text) as T[]) : [],
    count: total && total !== "*" ? Number(total) : null,
  };
}

async function rest(env: Env, key: string, method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new HttpError(502, "Could not update that error.");
}

async function restCount(env: Env, key: string, path: string): Promise<number> {
  const { count, rows } = await restPage<unknown>(env, key, path, 0, 0);
  if (count != null) return count;
  return Array.isArray(rows) ? rows.length : 0;
}
