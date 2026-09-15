import type { Env } from "./env";
import { HttpError, json } from "./http";
import { assertRateLimit } from "./rateLimit";
import {
  objectUrl,
  r2Client,
  requireR2,
  requireUser,
  restError,
  serviceRest,
  type AuthUser,
} from "./shared";
import {
  MAX_SCREENSHOT_BYTES,
  MIN_SCREENSHOT_BYTES,
  PNG_HEADER_BYTES,
  ScreenshotParseError,
  injectHead,
  isScreenshotSlug,
  mapRpcError,
  ownedScreenshotKey,
  parsePngHeader,
  prefixThenRest,
  productionStreamAdapter,
  randomScreenshotSlug,
  screenshotHeadTags,
  screenshotImagePath,
  screenshotSharePath,
  type ScreenshotStreamAdapter,
} from "./screenshotsCore";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_UPLOAD_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 200;

export type WaitCtx = { waitUntil(task: Promise<unknown>): void };

export type ScreenshotDeps = {
  streams: ScreenshotStreamAdapter;
  fetchSpaShell?: (request: Request, env: Env) => Promise<string>;
  deleteObject?: (env: Env, key: string) => Promise<void>;
};

const defaultDeps: ScreenshotDeps = {
  streams: productionStreamAdapter(),
};

interface ScreenshotRow {
  id: string;
  user_id: string;
  slug: string;
  storage_key: string | null;
  width: number;
  height: number;
  file_size_bytes: number;
  status: string;
  created_at: string;
  ready_at?: string | null;
}

interface FinalizeResult {
  slug: string;
  width: number;
  height: number;
  evicted: { id: string; key: string | null }[];
  usage: { count: number; bytes: number };
  limits: { count: number | null; bytes: number | null };
  trimAfter: string | null;
}

interface UsageResult {
  count: number;
  bytes: number;
  countLimit: number | null;
  bytesLimit: number | null;
  trimAfter: string | null;
}

export async function handleScreenshotApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: WaitCtx,
  deps: ScreenshotDeps = defaultDeps,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/v1/screenshots") {
    return createScreenshot(request, env, ctx, deps);
  }
  if (request.method === "GET" && url.pathname === "/v1/screenshots") {
    return listScreenshots(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/v1/screenshots/usage") {
    return screenshotUsage(request, env);
  }
  const publicMatch = url.pathname.match(/^\/v1\/screenshots\/public\/([^/]+)$/);
  if (request.method === "GET" && publicMatch?.[1]) {
    return publicScreenshot(env, publicMatch[1]);
  }
  const item = url.pathname.match(/^\/v1\/screenshots\/([^/]+)$/);
  if (request.method === "DELETE" && item?.[1]) {
    return deleteOwnedScreenshot(request, env, ctx, item[1]);
  }
  return null;
}

/**
 * Share pages and PNG bytes. Must run before the coming-soon gate so Discord's crawler
 * (and anyone with the link) can unfurl without the site-access cookie.
 */
export async function handleScreenshotShare(
  request: Request,
  env: Env,
  url: URL,
  deps: ScreenshotDeps = defaultDeps,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const png = url.pathname.match(/^\/s\/([a-km-z2-9]{12})\.png$/);
  if (png?.[1]) return serveScreenshotPng(request, env, png[1]);
  const page = url.pathname.match(/^\/s\/([a-km-z2-9]{12})\/?$/);
  if (page?.[1]) return serveScreenshotPage(request, env, page[1], deps);
  if (url.pathname.startsWith("/s/")) {
    return screenshotNotFoundPage(request, env, deps, "missing");
  }
  return null;
}

let activeDelete: ((env: Env, key: string) => Promise<void>) | undefined;

export async function sweepScreenshots(env: Env, ctx: WaitCtx, deps: ScreenshotDeps = defaultDeps): Promise<void> {
  activeDelete = deps.deleteObject;
  requireR2(env);
  const cutoff = new Date(Date.now() - STALE_UPLOAD_MS).toISOString();
  const stale = await serviceRest<ScreenshotRow[]>(
    env,
    "GET",
    `/screenshots?status=eq.uploading&created_at=lt.${cutoff}&select=id,user_id&limit=${SWEEP_BATCH}`,
  );
  for (const row of stale) {
    await rpc(env, "fail_screenshot", { p_user_id: row.user_id, p_id: row.id }).catch(() => undefined);
  }

  const purge = await serviceRest<ScreenshotRow[]>(
    env,
    "GET",
    `/screenshots?status=in.(failed,deleted)&storage_key=not.is.null&select=id,user_id,storage_key&limit=${SWEEP_BATCH}`,
  );
  for (const row of purge) {
    if (!ownedScreenshotKey(row.user_id, row.storage_key)) continue;
    await deleteScreenshotObject(env, row.storage_key);
    await rpc(env, "mark_screenshot_purged", { p_id: row.id, p_key: row.storage_key }).catch(() => undefined);
  }

  await rpc(env, "schedule_screenshot_trims", {});
  const evicted = await rpc<unknown>(env, "apply_screenshot_trims", { p_batch: SWEEP_BATCH });
  const rows = Array.isArray(evicted) ? evicted : [];
  for (const item of rows) {
    const row = item as { id?: string; key?: string; userId?: string };
    if (!row.key || !row.userId || !ownedScreenshotKey(row.userId, row.key)) continue;
    ctx.waitUntil(deleteScreenshotObject(env, row.key));
  }
}

export async function purgeUserScreenshots(env: Env, userId: string): Promise<void> {
  let offset = 0;
  for (;;) {
    const rows = await serviceRest<ScreenshotRow[]>(
      env,
      "GET",
      `/screenshots?user_id=eq.${userId}&select=id,user_id,storage_key,status&limit=100&offset=${offset}`,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (ownedScreenshotKey(userId, row.storage_key)) {
        await deleteScreenshotObject(env, row.storage_key);
      }
      if (row.status !== "deleted") {
        await rpc(env, "delete_screenshot", { p_user_id: userId, p_id: row.id }).catch(() => undefined);
      }
    }
    if (rows.length < 100) break;
    offset += rows.length;
  }
}

async function createScreenshot(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  deps: ScreenshotDeps,
): Promise<Response> {
  activeDelete = deps.deleteObject;
  let user: AuthUser;
  try {
    user = await requireUser(request, env);
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 401) {
      throw new HttpError(401, caught.message, "unauthorized");
    }
    throw caught;
  }
  try {
    assertRateLimit(request, "screenshot-upload", 30, user.id);
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 429) {
      throw new HttpError(429, caught.message, "rate_limited");
    }
    throw caught;
  }
  requireR2(env);

  const length = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(length) || length <= 0) {
    throw new HttpError(400, "Content-Length is required.", "screenshot_not_png");
  }
  if (length > MAX_SCREENSHOT_BYTES) {
    throw new HttpError(413, "That screenshot is too large.", "screenshot_too_large");
  }
  if (length < MIN_SCREENSHOT_BYTES) {
    throw new HttpError(415, "That file is not a PNG.", "screenshot_not_png");
  }
  if (!request.body) {
    throw new HttpError(400, "That file is not a PNG.", "screenshot_not_png");
  }

  let prefix: Uint8Array;
  let rest: ReadableStream<Uint8Array>;
  try {
    const split = await prefixThenRest(request.body, PNG_HEADER_BYTES);
    prefix = split.prefix;
    rest = split.rest;
  } catch {
    throw new HttpError(415, "That file is not a PNG.", "screenshot_not_png");
  }

  let header;
  try {
    header = parsePngHeader(prefix);
  } catch (caught) {
    if (caught instanceof ScreenshotParseError) {
      throw new HttpError(
        caught.code === "screenshot_too_large" ? 413 : 415,
        caught.message,
        caught.code,
      );
    }
    throw caught;
  }

  const id = crypto.randomUUID();
  const key = await reserveWithSlugRetry(env, user.id, id, length, header.width, header.height);
  const restBytes = new Uint8Array(await new Response(rest).arrayBuffer());
  const png = new Uint8Array(prefix.byteLength + restBytes.byteLength);
  png.set(prefix, 0);
  png.set(restBytes, prefix.byteLength);
  if (png.byteLength !== length) {
    await rpc(env, "fail_screenshot", { p_user_id: user.id, p_id: id }).catch(() => undefined);
    throw new HttpError(415, "That file is not a PNG.", "screenshot_not_png");
  }

  try {
    const put = await r2Client(env).fetch(objectUrl(env, key), {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        "content-length": String(length),
      },
      body: png,
    });
    if (!put.ok) {
      throw new HttpError(502, "Could not store that screenshot.", "screenshot_not_png");
    }
  } catch (caught) {
    await rpc(env, "fail_screenshot", { p_user_id: user.id, p_id: id }).catch(() => undefined);
    throw caught instanceof HttpError ? caught : new HttpError(502, "Could not store that screenshot.");
  }

  let finalized: FinalizeResult;
  try {
    finalized = normalizeFinalize(await rpc<FinalizeResult>(env, "finalize_screenshot", { p_user_id: user.id, p_id: id }));
  } catch (caught) {
    await rpc(env, "fail_screenshot", { p_user_id: user.id, p_id: id }).catch(() => undefined);
    throw caught;
  }

  for (const evicted of finalized.evicted) {
    if (evicted.key && ownedScreenshotKey(user.id, evicted.key)) {
      ctx.waitUntil(deleteScreenshotObject(env, evicted.key));
    }
  }

  const origin = shareOrigin(env);
  return json(
    {
      id,
      slug: finalized.slug,
      shareUrl: `${origin}${screenshotSharePath(finalized.slug)}`,
      width: finalized.width,
      height: finalized.height,
      bytes: length,
      replacedOldest: finalized.evicted.length > 0,
      evictedIds: finalized.evicted.map((item) => item.id),
      usage: finalized.usage,
    },
    201,
  );
}

async function listScreenshots(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const rawPage = Number(url.searchParams.get("page"));
  const rawLimit = Number(url.searchParams.get("limit"));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(48, Math.floor(rawLimit)) : 24;
  const offset = (page - 1) * limit;
  const filter = `user_id=eq.${user.id}&status=in.(ready,uploading,failed)`;
  const [rows, total] = await Promise.all([
    serviceRest<ScreenshotRow[]>(
      env,
      "GET",
      `/screenshots?${filter}&select=id,slug,width,height,file_size_bytes,status,created_at&order=created_at.desc&limit=${limit}&offset=${offset}`,
    ),
    serviceRestCountExact(env, `/screenshots?${filter}`),
  ]);
  const origin = shareOrigin(env);
  return json({
    screenshots: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      shareUrl: row.status === "ready" ? `${origin}${screenshotSharePath(row.slug)}` : null,
      width: row.width,
      height: row.height,
      bytes: row.file_size_bytes,
      status: row.status,
      createdAt: row.created_at,
    })),
    total,
    page,
    limit,
  });
}

async function screenshotUsage(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const usage = normalizeUsage(await rpc<UsageResult>(env, "screenshot_usage_for", { p_user_id: user.id }));
  return json(usage);
}

async function publicScreenshot(env: Env, slug: string): Promise<Response> {
  if (!isScreenshotSlug(slug)) {
    throw new HttpError(404, "That screenshot was not found.");
  }
  const rows = await serviceRest<ScreenshotRow[]>(
    env,
    "GET",
    `/screenshots?slug=eq.${slug}&status=eq.ready&select=id,slug,width,height,file_size_bytes,created_at,status`,
  );
  const row = rows[0];
  if (!row || row.status !== "ready") {
    throw new HttpError(404, "That screenshot was not found.");
  }
  return json({
    slug: row.slug,
    width: row.width,
    height: row.height,
    bytes: row.file_size_bytes,
    createdAt: row.created_at,
  });
}

async function deleteOwnedScreenshot(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  id: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  if (!UUID.test(id)) throw new HttpError(400, "That screenshot was not found.");
  const key = await rpc<string | null>(env, "delete_screenshot", { p_user_id: user.id, p_id: id });
  if (typeof key === "string" && ownedScreenshotKey(user.id, key)) {
    ctx.waitUntil(deleteScreenshotObject(env, key));
  }
  return json({ id, status: "deleted" });
}

async function serveScreenshotPage(
  request: Request,
  env: Env,
  slug: string,
  deps: ScreenshotDeps,
): Promise<Response> {
  const found = await lookupReady(env, slug);
  if (!found) {
    try {
      assertRateLimit(request, "screenshot-miss", 30);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 429) {
        throw new HttpError(429, caught.message, "rate_limited");
      }
      throw caught;
    }
  }
  const origin = absoluteOrigin(request, env);
  const html = await spaShell(request, env, deps);
  const injected = injectHead(
    html,
    screenshotHeadTags({
      origin,
      slug,
      found: Boolean(found),
      width: found?.width,
      height: found?.height,
    }),
  );
  return htmlResponse(injected, found ? 200 : 404, request.method === "HEAD");
}

async function screenshotNotFoundPage(
  request: Request,
  env: Env,
  deps: ScreenshotDeps,
  slug: string,
): Promise<Response> {
  const origin = absoluteOrigin(request, env);
  const html = await spaShell(request, env, deps);
  const injected = injectHead(html, screenshotHeadTags({ origin, slug, found: false }));
  return htmlResponse(injected, 404, request.method === "HEAD");
}

async function serveScreenshotPng(request: Request, env: Env, slug: string): Promise<Response> {
  requireR2(env);
  const row = await lookupReady(env, slug);
  if (!row || !ownedScreenshotKey(row.user_id, row.storage_key)) {
    try {
      assertRateLimit(request, "screenshot-miss", 30);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 429) {
        throw new HttpError(429, caught.message, "rate_limited");
      }
      throw caught;
    }
    throw new HttpError(404, "That screenshot was not found.");
  }
  const signed = await r2Client(env).sign(`${objectUrl(env, row.storage_key)}?X-Amz-Expires=300`, {
    method: "GET",
    aws: { signQuery: true },
  });
  // Always GET from R2. The query is signed for GET; Discord/curl HEAD against that
  // signature 403s and the embed shows no image.
  const upstream = await fetch(signed.url, { method: "GET" });
  if (!upstream.ok) {
    throw new HttpError(404, "That screenshot was not found.");
  }
  const headers = new Headers();
  headers.set("content-type", "image/png");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", "inline");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("x-robots-tag", "noindex");
  headers.set("cache-control", "public, max-age=300");
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("etag", etag);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
}

async function lookupReady(env: Env, slug: string): Promise<ScreenshotRow | null> {
  if (!isScreenshotSlug(slug)) return null;
  const rows = await serviceRest<ScreenshotRow[]>(
    env,
    "GET",
    `/screenshots?slug=eq.${slug}&status=eq.ready&select=id,user_id,slug,storage_key,width,height,file_size_bytes,status,created_at`,
  );
  const row = rows[0];
  if (!row || row.status !== "ready") return null;
  return row;
}

async function reserveWithSlugRetry(
  env: Env,
  userId: string,
  id: string,
  bytes: number,
  width: number,
  height: number,
): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomScreenshotSlug();
    try {
      const key = await rpc<string>(env, "reserve_screenshot", {
        p_user_id: userId,
        p_id: id,
        p_slug: slug,
        p_bytes: bytes,
        p_width: width,
        p_height: height,
      });
      if (typeof key !== "string" || !ownedScreenshotKey(userId, key)) {
        throw new HttpError(502, "Could not reserve screenshot storage.");
      }
      return key;
    } catch (caught) {
      last = caught;
      if (caught instanceof HttpError && caught.status === 409) continue;
      const mapped = caught instanceof HttpError ? mapRpcError(caught.message) : null;
      if (mapped) throw new HttpError(mapped.status, mapped.error, mapped.code);
      throw caught;
    }
  }
  throw last instanceof HttpError ? last : new HttpError(500, "Could not allocate a screenshot URL.");
}

async function rpc<T>(env: Env, name: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await serviceRest<T>(env, "POST", `/rpc/${name}`, body);
  } catch (caught) {
    if (caught instanceof HttpError) {
      const mapped = mapRpcError(caught.message);
      if (mapped) throw new HttpError(mapped.status, mapped.error, mapped.code);
    }
    throw caught;
  }
}

async function deleteScreenshotObject(env: Env, key: string): Promise<void> {
  try {
    if (activeDelete) {
      await activeDelete(env, key);
      return;
    }
    await r2Client(env).fetch(objectUrl(env, key), { method: "DELETE" });
  } catch {
    /* best-effort purge; CAS happens after */
  }
}

async function serviceRestCountExact(env: Env, path: string): Promise<number> {
  const key = requireServiceRoleSafe(env);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
      range: "0-0",
    },
  });
  const total = response.headers.get("content-range")?.split("/")[1];
  return total && total !== "*" ? Number(total) : 0;
}

function requireServiceRoleSafe(env: Env): string {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Cloud quota is not configured on the Worker.");
  }
  return env.SUPABASE_SERVICE_ROLE_KEY;
}

function shareOrigin(env: Env): string {
  const origin = (env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  try {
    const host = new URL(origin).hostname;
    if (host === "127.0.0.1" || host === "localhost") return "https://replayr.tv";
  } catch {
    /* keep configured origin */
  }
  return origin || "https://replayr.tv";
}

function absoluteOrigin(request: Request, env: Env): string {
  const configured = shareOrigin(env);
  try {
    const host = new URL(request.url).hostname;
    if (host === "127.0.0.1" || host === "localhost") return new URL(request.url).origin;
  } catch {
    /* use configured */
  }
  return configured;
}

async function spaShell(request: Request, env: Env, deps: ScreenshotDeps): Promise<string> {
  if (deps.fetchSpaShell) return deps.fetchSpaShell(request, env);
  if (!env.ASSETS) return "<!doctype html><html><head></head><body><div id='root'></div></body></html>";
  let asset = await env.ASSETS.fetch(new URL("/", request.url).toString());
  if (!asset.ok) {
    asset = await env.ASSETS.fetch(new URL("/index.html", request.url).toString());
  }
  return asset.text();
}

function htmlResponse(html: string, status: number, head: boolean): Response {
  return new Response(head ? null : html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeFinalize(value: FinalizeResult): FinalizeResult {
  return {
    slug: value.slug,
    width: Number(value.width),
    height: Number(value.height),
    evicted: Array.isArray(value.evicted) ? value.evicted : [],
    usage: value.usage ?? { count: 0, bytes: 0 },
    limits: value.limits ?? { count: null, bytes: null },
    trimAfter: value.trimAfter ?? null,
  };
}

function normalizeUsage(value: UsageResult): UsageResult {
  return {
    count: Number(value.count ?? 0),
    bytes: Number(value.bytes ?? 0),
    countLimit: value.countLimit ?? null,
    bytesLimit: value.bytesLimit ?? null,
    trimAfter: value.trimAfter ?? null,
  };
}

// Keep requireUser import used; AuthUser is the return type of requireUser.
export type { AuthUser };
