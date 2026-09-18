import { coarseCountry } from "./analytics";
import type { Env } from "./env";
import { json } from "./http";
import { assertRateLimit } from "./rateLimit";
import { optionalUser, serviceRest } from "./shared";

export const LIVE_SURFACES = ["web", "coming-soon", "desktop", "api", "admin"] as const;
export type LiveSurface = (typeof LIVE_SURFACES)[number];

export const PRESENCE_ANON_LIMIT = 20;
export const PRESENCE_AUTH_LIMIT = 40;

const SKIP_EXACT = new Set([
  "/v1/presence/ping",
  "/v1/health",
  "/v1/admin/analytics/live",
  "/v1/admin/analytics/traffic",
  "/v1/billing/webhook",
  "/internal/webhooks/bunny",
]);

export function shouldSkipLiveTouch(pathname: string): boolean {
  if (SKIP_EXACT.has(pathname)) return true;
  if (pathname.startsWith("/internal/bunny-source/")) return true;
  if (pathname.startsWith("/v1/admin") || pathname.startsWith("/v1/staff")) return true;
  if (pathname.startsWith("/v1/notifications")) return true;
  if (pathname.startsWith("/v1/") || pathname.startsWith("/internal/")) return false;
  return true;
}

export type LiveVisitorRow = {
  visitor_key: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  colo: string | null;
  path: string | null;
  surface: LiveSurface;
  user_id: string | null;
  user_agent: string | null;
  last_seen: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
};

export function isLiveSurface(value: unknown): value is LiveSurface {
  return typeof value === "string" && (LIVE_SURFACES as readonly string[]).includes(value);
}

export function inferLiveSurface(pathname: string, requested?: string | null): LiveSurface {
  if (isLiveSurface(requested)) return requested;
  if (pathname.startsWith("/v1/admin") || pathname.startsWith("/admin") || pathname.startsWith("/staff")) return "admin";
  if (pathname === "/coming-soon" || pathname === "/coming-soon.html" || pathname === "/waitlist") return "coming-soon";
  if (pathname.startsWith("/v1/")) return "api";
  return "web";
}

export function sanitizeVisitorKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 80) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function sanitizePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 160);
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const raw = (request.headers.get("cf-connecting-ip") || forwarded).trim();
  if (!raw || raw.length > 45 || raw === "local") return null;
  return raw;
}

export async function hashVisitorKey(ip: string, userAgent: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${userAgent}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cfGeo(request: Request): { city: string | null; colo: string | null } {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const city = typeof cf?.city === "string" ? cf.city.trim().slice(0, 80) : "";
  const colo = typeof cf?.colo === "string" ? cf.colo.trim().slice(0, 16) : "";
  return { city: city || null, colo: colo || null };
}

export async function resolveVisitorKey(request: Request, hinted?: string | null): Promise<string> {
  const fromHint = sanitizeVisitorKey(hinted);
  if (fromHint) return fromHint;
  const ip = clientIp(request) || "0.0.0.0";
  const ua = (request.headers.get("user-agent") || "unknown").slice(0, 180);
  return hashVisitorKey(ip, ua);
}

export async function touchLiveVisitor(
  request: Request,
  env: Env,
  input: { path: string; surface?: string | null; visitorKey?: string | null; userId?: string | null },
): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  const path = sanitizePath(input.path) || "/";
  const surface = inferLiveSurface(path, input.surface);
  const userId = input.userId ?? null;
  const visitorKey = await resolveVisitorKey(request, input.visitorKey);
  const geo = cfGeo(request);
  const ua = (request.headers.get("user-agent") || "").trim().slice(0, 180) || null;
  await serviceRest(env, "POST", "/rpc/upsert_live_visitor", {
    p_visitor_key: visitorKey,
    p_ip: clientIp(request),
    p_country: coarseCountry(request),
    p_city: geo.city,
    p_colo: geo.colo,
    p_path: path,
    p_surface: surface,
    p_user_id: userId,
    p_user_agent: ua,
  });
}

export async function handlePresence(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/v1/presence/ping" || request.method !== "POST") return null;
  const user = await optionalUser(request, env);
  assertRateLimit(request, "presence", user ? PRESENCE_AUTH_LIMIT : PRESENCE_ANON_LIMIT, user?.id);
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const path = sanitizePath(payload?.path) || "/";
  await touchLiveVisitor(request, env, {
    path,
    surface: typeof payload?.surface === "string" ? payload.surface : null,
    visitorKey: typeof payload?.anonymousId === "string" ? payload.anonymousId : typeof payload?.sessionId === "string" ? payload.sessionId : null,
    userId: user?.id ?? null,
  });
  return json({ ok: true }, 202);
}

export async function listLiveVisitors(env: Env): Promise<{
  now: string;
  count: number;
  visitors: Array<{
    visitorKey: string;
    ip: string | null;
    country: string | null;
    city: string | null;
    colo: string | null;
    path: string | null;
    surface: LiveSurface;
    lastSeen: string;
    userAgent: string | null;
    user: { id: string; handle: string | null; displayName: string | null; email: string | null } | null;
  }>;
}> {
  const rows = await serviceRest<LiveVisitorRow[]>(env, "POST", "/rpc/list_live_visitors", {});
  const list = Array.isArray(rows) ? rows : [];
  return {
    now: new Date().toISOString(),
    count: list.length,
    visitors: list.map((row) => ({
      visitorKey: row.visitor_key,
      ip: row.ip,
      country: row.country,
      city: row.city,
      colo: row.colo,
      path: row.path,
      surface: isLiveSurface(row.surface) ? row.surface : "api",
      lastSeen: row.last_seen,
      userAgent: row.user_agent,
      user: row.user_id
        ? {
            id: row.user_id,
            handle: row.handle,
            displayName: row.display_name,
            email: row.email,
          }
        : null,
    })),
  };
}

export async function cleanupLiveVisitors(env: Env): Promise<number> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const [live, traffic] = await Promise.all([
    serviceRest<number>(env, "POST", "/rpc/cleanup_live_visitors", {}),
    serviceRest<number>(env, "POST", "/rpc/cleanup_visitor_traffic", {}),
  ]);
  return (typeof live === "number" ? live : 0) + (typeof traffic === "number" ? traffic : 0);
}

export function observeLiveVisitor(request: Request, env: Env, url: URL, ctx: { waitUntil(task: Promise<unknown>): void }): void {
  if (shouldSkipLiveTouch(url.pathname)) return;
  ctx.waitUntil(
    touchLiveVisitor(request, env, { path: url.pathname }).catch(() => undefined),
  );
}
