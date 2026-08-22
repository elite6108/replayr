import { AwsClient } from "aws4fetch";

export interface Env {
  CLIPS?: R2Bucket;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  PUBLIC_APP_URL: string;
}

const PART_SIZE = 8 * 1024 * 1024;
const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const CONTENT_TYPE = "video/mp4";

interface UploadBody {
  size?: number;
  contentType?: string;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  title?: string | null;
  gameSlug?: string | null;
}

interface CompleteBody {
  uploadId?: string | null;
  parts?: { partNumber: number; etag: string }[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (shouldUpgradeToHttps(url)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return json({
          ok: true,
          storage: Boolean(env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID && env.R2_ACCOUNT_ID),
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/library") {
        return cors(await listLibrary(request, env));
      }
      if (request.method === "GET" && url.pathname === "/v1/clips/public") {
        return cors(await listPublicClips(env));
      }
      const gameClips = url.pathname.match(/^\/v1\/games\/([^/]+)\/clips$/);
      if (request.method === "GET" && gameClips?.[1]) {
        return cors(await listGameClips(env, gameClips[1]));
      }
      if (request.method === "POST" && url.pathname === "/v1/clips/uploads") {
        return cors(await createUpload(request, env));
      }
      const complete = url.pathname.match(/^\/v1\/clips\/([^/]+)\/complete$/);
      if (request.method === "POST" && complete?.[1]) {
        return cors(await completeUpload(request, env, complete[1]));
      }
      const download = url.pathname.match(/^\/v1\/clips\/([^/]+)\/download$/);
      if (request.method === "GET" && download?.[1]) {
        return cors(await downloadClip(request, env, download[1]));
      }
      const clipItem = url.pathname.match(/^\/v1\/clips\/([^/]+)$/);
      if (request.method === "DELETE" && clipItem?.[1]) {
        return cors(await deleteClip(request, env, clipItem[1]));
      }
      if (request.method === "GET" && clipItem?.[1]) {
        return cors(await getPlayback(request, env, clipItem[1]));
      }
      const share = url.pathname.match(/^\/c\/([^/]+)\/?$/);
      if (request.method === "GET" && share?.[1]) {
        return clipPlayerPage(request, env, share[1]);
      }
      if (request.method === "GET" && url.pathname === "/") {
        if (env.ASSETS) return env.ASSETS.fetch(request);
        return siteLanding(env);
      }
      if (request.method === "GET" && (url.pathname === "/library" || url.pathname === "/signin")) {
        if (env.ASSETS) return env.ASSETS.fetch(request);
      }
      if (env.ASSETS && request.method === "GET") {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "Not found." }, 404);
    } catch (caught) {
      if (caught instanceof HttpError) {
        return json({ error: caught.message }, caught.status);
      }
      const message = caught instanceof Error ? caught.message : "Worker failed.";
      return json({ error: message }, 500);
    }
  },
};

async function createUpload(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  requireR2(env);
  const body = (await request.json()) as UploadBody;
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return json({ error: "Clip file size is required." }, 400);
  }
  const storage = await rest<StorageRow[]>(
    env,
    user.token,
    "GET",
    `/user_storage?user_id=eq.${user.id}&select=storage_used_bytes,storage_limit_bytes`,
  );
  const quota = storage[0];
  if (!quota) {
    return json({ error: "No storage plan is attached to this account." }, 403);
  }
  if (quota.storage_used_bytes + size > quota.storage_limit_bytes) {
    return json({ error: "This clip would exceed your cloud storage limit." }, 403);
  }

  const clipId = crypto.randomUUID();
  const key = `clips/${user.id}/${clipId}/original.mp4`;
  const thumbKey = `clips/${user.id}/${clipId}/thumb`;
  const gameId = await lookupGame(env, user.token, body.gameSlug ?? null);
  const slug = await insertClip(env, user, {
    id: clipId,
    user_id: user.id,
    game_id: gameId,
    title: body.title ?? null,
    storage_key: key,
    thumbnail_key: thumbKey,
    duration_ms: body.durationMs ?? null,
    width: body.width ?? null,
    height: body.height ?? null,
    fps: body.fps ?? null,
    codec: "h264",
    visibility: "unlisted",
    status: "uploading",
  });

  const aws = r2Client(env);
  const endpoint = objectUrl(env, key);
  let uploadId: string | null = null;
  const parts: { partNumber: number; url: string }[] = [];
  const signHeaders = { "content-type": CONTENT_TYPE };

  if (size > PART_SIZE) {
    const started = await aws.fetch(`${endpoint}?uploads`, { method: "POST" });
    const xml = await started.text();
    if (!started.ok) {
      return json({ error: `Could not start multipart upload: ${xml}` }, 502);
    }
    uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1] ?? null;
    if (!uploadId) {
      return json({ error: "R2 did not return an upload id." }, 502);
    }
    const count = Math.ceil(size / PART_SIZE);
    for (let partNumber = 1; partNumber <= count; partNumber += 1) {
      const signed = await aws.sign(
        `${endpoint}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
        { method: "PUT", headers: signHeaders, aws: { signQuery: true } },
      );
      parts.push({ partNumber, url: signed.url });
    }
  } else {
    const signed = await aws.sign(endpoint, { method: "PUT", headers: signHeaders, aws: { signQuery: true } });
    parts.push({ partNumber: 1, url: signed.url });
  }

  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await rest(env, user.token, "POST", "/upload_sessions", {
    clip_id: clipId,
    user_id: user.id,
    storage_key: key,
    multipart_upload_id: uploadId,
    expected_size_bytes: size,
    declared_content_type: CONTENT_TYPE,
    status: "uploading",
    expires_at: expires,
  });

  return json({
    clipId,
    slug,
    key,
    thumbKey,
    thumbUrl: (await signObject(env, thumbKey, "PUT", { "content-type": "image/bmp" })).url,
    uploadId,
    partSize: PART_SIZE,
    parts,
  });
}

async function completeUpload(request: Request, env: Env, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  requireR2(env);
  const body = (await request.json()) as CompleteBody;
  const clips = await rest<ClipRow[]>(
    env,
    user.token,
    "GET",
    `/clips?id=eq.${clipId}&user_id=eq.${user.id}&select=id,slug,storage_key,status`,
  );
  const clip = clips[0];
  if (!clip?.storage_key) {
    return json({ error: "Clip upload was not found." }, 404);
  }

  if (body.uploadId && body.parts?.length) {
    const xml = [
      "<CompleteMultipartUpload>",
      ...body.parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag.replaceAll('"', "")}"</ETag></Part>`),
      "</CompleteMultipartUpload>",
    ].join("");
    const done = await r2Client(env).fetch(`${objectUrl(env, clip.storage_key)}?uploadId=${encodeURIComponent(body.uploadId)}`, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: xml,
    });
    if (!done.ok) {
      return json({ error: `Could not finish multipart upload: ${await done.text()}` }, 502);
    }
  }

  const size = await objectSize(env, clip.storage_key);
  if (size == null || size <= 0) {
    await rest(env, user.token, "PATCH", `/clips?id=eq.${clipId}`, { status: "failed" });
    return json({ error: "Uploaded object was not found in cloud storage." }, 400);
  }

  try {
    await rest(env, user.token, "POST", "/rpc/add_storage_used", { p_bytes: size });
  } catch (caught) {
    if (env.CLIPS) await env.CLIPS.delete(clip.storage_key);
    else await r2Client(env).fetch(objectUrl(env, clip.storage_key), { method: "DELETE" });
    await rest(env, user.token, "PATCH", `/clips?id=eq.${clipId}`, { status: "failed" });
    throw caught;
  }

  await rest(env, user.token, "PATCH", `/clips?id=eq.${clipId}`, {
    status: "ready",
    file_size_bytes: size,
  });
  await rest(env, user.token, "PATCH", `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}`, {
    status: "completed",
  });

  const origin = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return json({
    clipId,
    slug: clip.slug,
    status: "ready",
    shareUrl: `${origin}/c/${clip.slug}`,
  });
}

async function deleteClip(request: Request, env: Env, clipId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clipId)) {
    return json({ error: "Clip id is invalid." }, 400);
  }
  const user = await requireUser(request, env);
  const clips = await rest<ClipRow[]>(
    env,
    user.token,
    "GET",
    `/clips?id=eq.${clipId}&user_id=eq.${user.id}&select=id,slug,storage_key,thumbnail_key,status,file_size_bytes`,
  );
  const clip = clips[0];
  if (!clip || clip.status === "deleted") {
    return json({ error: "That cloud clip was not found." }, 404);
  }

  if (clip.storage_key) {
    requireR2(env);
    if (env.CLIPS) await env.CLIPS.delete(clip.storage_key);
    else await r2Client(env).fetch(objectUrl(env, clip.storage_key), { method: "DELETE" });
  }

  if (clip.thumbnail_key) {
    if (env.CLIPS) await env.CLIPS.delete(clip.thumbnail_key);
    else await r2Client(env).fetch(objectUrl(env, clip.thumbnail_key), { method: "DELETE" });
  }

  if (clip.status === "ready" && clip.file_size_bytes && clip.file_size_bytes > 0) {
    await rest(env, user.token, "POST", "/rpc/release_storage_used", { p_bytes: clip.file_size_bytes });
  }

  await rest(env, user.token, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, {
    status: "deleted",
    storage_key: null,
    thumbnail_key: null,
  });
  await rest(env, user.token, "DELETE", `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}`);

  return json({ clipId, status: "deleted" });
}

async function listLibrary(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await rest<LibraryRow[]>(
    env,
    user.token,
    "GET",
    `/clips?user_id=eq.${user.id}&status=neq.deleted&select=id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key&order=created_at.desc`,
  );
  requireR2(env);
  const clips = [];
  for (const row of rows) {
    const thumbnailUrl =
      row.status === "ready" && row.thumbnail_key ? (await signObject(env, row.thumbnail_key, "GET")).url : null;
    const playbackUrl =
      row.status === "ready" && row.storage_key ? (await signObject(env, row.storage_key, "GET")).url : null;
    clips.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      visibility: row.visibility,
      durationMs: row.duration_ms,
      width: row.width,
      height: row.height,
      fileSizeBytes: row.file_size_bytes,
      createdAt: row.created_at,
      thumbnailUrl,
      playbackUrl,
    });
  }
  return json({ clips });
}

async function listGameClips(env: Env, slug: string): Promise<Response> {
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return json({ error: "That game was not found." }, 404);
  }
  const games = await rest<GameRow[]>(
    env,
    env.SUPABASE_ANON_KEY,
    "GET",
    `/games?slug=eq.${encodeURIComponent(slug)}&select=id,slug,name,publisher,cover_url`,
  );
  const game = games[0];
  if (!game) {
    return json({ error: "That game was not found." }, 404);
  }
  const rows = await rest<LibraryRow[]>(
    env,
    env.SUPABASE_ANON_KEY,
    "GET",
    `/clips?game_id=eq.${game.id}&visibility=eq.public&status=eq.ready&select=id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key&order=created_at.desc&limit=48`,
  );
  requireR2(env);
  const clips = [];
  for (const row of rows) {
    const thumbnailUrl = row.thumbnail_key ? (await signObject(env, row.thumbnail_key, "GET")).url : null;
    const playbackUrl = row.storage_key ? (await signObject(env, row.storage_key, "GET")).url : null;
    clips.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      visibility: row.visibility,
      durationMs: row.duration_ms,
      width: row.width,
      height: row.height,
      fileSizeBytes: row.file_size_bytes,
      createdAt: row.created_at,
      thumbnailUrl,
      playbackUrl,
    });
  }
  return json({ game, clips });
}

async function listPublicClips(env: Env): Promise<Response> {
  const rows = await rest<PublicClipRow[]>(
    env,
    env.SUPABASE_ANON_KEY,
    "GET",
    "/clips?visibility=eq.public&status=eq.ready&select=id,title,slug,duration_ms,created_at,storage_key,thumbnail_key,games(name,slug,cover_url)&order=created_at.desc&limit=12",
  );
  requireR2(env);
  const clips = [];
  for (const row of rows) {
    const game = Array.isArray(row.games) ? row.games[0] : row.games;
    clips.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      thumbnailUrl: row.thumbnail_key ? (await signObject(env, row.thumbnail_key, "GET")).url : null,
      playbackUrl: row.storage_key ? (await signObject(env, row.storage_key, "GET")).url : null,
      game: game
        ? { name: game.name, slug: game.slug, coverUrl: game.cover_url }
        : null,
    });
  }
  return json({ clips });
}

async function downloadClip(request: Request, env: Env, slug: string): Promise<Response> {
  const clip = await lookupPlayback(request, env, slug);
  if (!clip?.storage_key) {
    return json({ error: "That clip is not available." }, 404);
  }
  requireR2(env);
  const signed = await r2Client(env).sign(`${objectUrl(env, clip.storage_key)}?X-Amz-Expires=3600`, {
    method: "GET",
    aws: { signQuery: true },
  });
  const object = await fetch(signed.url);
  if (!object.ok || !object.body) {
    return json({ error: "Could not download that clip." }, 502);
  }
  const filename = downloadFileName(clip.title, clip.slug);
  const headers = new Headers();
  headers.set("content-type", object.headers.get("content-type") || CONTENT_TYPE);
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  const length = object.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(object.body, { status: 200, headers });
}

function downloadFileName(title: string | null, slug: string) {
  const base = (title || slug)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "clip"}.mp4`;
}

async function getPlayback(request: Request, env: Env, slug: string): Promise<Response> {
  const clip = await lookupPlayback(request, env, slug);
  if (!clip?.storage_key) {
    return json({ error: "That clip is not available." }, 404);
  }
  requireR2(env);
  const signed = await r2Client(env).sign(`${objectUrl(env, clip.storage_key)}?X-Amz-Expires=3600`, {
    method: "GET",
    aws: { signQuery: true },
  });
  return json({
    slug: clip.slug,
    title: clip.title,
    durationMs: clip.duration_ms,
    width: clip.width,
    height: clip.height,
    visibility: clip.visibility,
    status: clip.status,
    playbackUrl: signed.url,
  });
}

async function lookupPlayback(request: Request, env: Env, slug: string): Promise<PlaybackRow | null> {
  const token = bearerToken(request) || env.SUPABASE_ANON_KEY;
  const rows = await rest<PlaybackRow[]>(env, token, "POST", "/rpc/get_clip_for_playback", { p_slug: slug });
  return rows[0] ?? null;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

async function clipPlayerPage(request: Request, env: Env, slug: string): Promise<Response> {
  if (env.ASSETS) {
    const index = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(index, request));
  }
  const origin = env.PUBLIC_APP_URL.replace(/\/$/, "") || new URL(request.url).origin;
  const safeSlug = slug.replace(/[^a-z0-9]/g, "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Replayr</title>
  <meta name="robots" content="noindex" />
  <style>
    :root { color-scheme: dark; --bg:#0b0c0f; --text:#e8eaed; --muted:#8b929c; --accent:#6cb4d4; --raised:#161a21; --border:#262b34; }
    * { box-sizing: border-box; }
    body { margin:0; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
    a { color: var(--accent); }
    .muted { color: var(--muted); }
    video { width: 100%; background: #000; border-radius: 8px; border: 1px solid var(--border); }
    h1 { font-size: 1.25rem; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <p class="muted"><a href="${origin}/">Replayr</a></p>
    <h1 id="title">Loading clip…</h1>
    <p id="error" class="muted"></p>
    <video id="player" controls playsinline></video>
  </main>
  <script>
    const slug = ${JSON.stringify(safeSlug)};
    fetch("/v1/clips/" + slug).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Clip unavailable");
      document.getElementById("title").textContent = data.title || "Untitled clip";
      document.title = (data.title || "Clip") + " · Replayr";
      document.getElementById("player").src = data.playbackUrl;
    }).catch((err) => {
      document.getElementById("title").textContent = "Clip unavailable";
      document.getElementById("error").textContent = err.message;
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function insertClip(env: Env, user: AuthUser, row: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = randomSlug();
    try {
      await rest(env, user.token, "POST", "/clips", { ...row, slug });
      return slug;
    } catch (caught) {
      const text = caught instanceof HttpError ? caught.message : "";
      if (caught instanceof HttpError && (caught.status === 409 || /duplicate|unique/i.test(text))) continue;
      throw caught;
    }
  }
  throw new HttpError(500, "Could not allocate a clip URL.");
}

async function requireUser(request: Request, env: Env): Promise<AuthUser> {
  const header = request.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (!token) {
    throw new HttpError(401, "Sign in required.");
  }
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) {
    throw new HttpError(401, "Session expired. Sign in again.");
  }
  const user = (await response.json()) as { id?: string };
  if (!user.id) {
    throw new HttpError(401, "Session expired. Sign in again.");
  }
  return { id: user.id, token };
}

async function lookupGame(env: Env, token: string, slug: string | null): Promise<string | null> {
  if (!slug) return null;
  const rows = await rest<{ id: string }[]>(
    env,
    token,
    "GET",
    `/games?slug=eq.${encodeURIComponent(slug)}&select=id`,
  );
  return rows[0]?.id ?? null;
}

async function objectSize(env: Env, key: string): Promise<number | null> {
  if (env.CLIPS) {
    const object = await env.CLIPS.head(key);
    return object?.size ?? null;
  }
  const response = await r2Client(env).fetch(objectUrl(env, key), { method: "HEAD" });
  if (!response.ok) return null;
  const length = response.headers.get("content-length");
  const size = length ? Number(length) : NaN;
  return Number.isFinite(size) ? size : null;
}

function requireR2(env: Env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new HttpError(503, "Cloud storage is not configured on the Worker.");
  }
}

function r2Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function objectUrl(env: Env, key: string) {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
}

function signObject(env: Env, key: string, method: "GET" | "PUT", headers?: Record<string, string>) {
  return r2Client(env).sign(`${objectUrl(env, key)}?X-Amz-Expires=3600`, {
    method,
    headers,
    aws: { signQuery: true },
  });
}

async function rest<T>(env: Env, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: method === "POST" && path.startsWith("/rpc/")
        ? "return=representation"
        : method === "POST" || method === "DELETE"
          ? "return=minimal"
          : "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status === 409 ? 409 : 502, restError(text) || "Supabase request failed.");
  }
  if (!text) return [] as T;
  return JSON.parse(text) as T;
}

function restError(body: string): string {
  try {
    const value = JSON.parse(body) as { message?: string; hint?: string; details?: string };
    return value.message || value.hint || value.details || body;
  } catch {
    return body;
  }
}

function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (value) => SLUG_ALPHABET[value % SLUG_ALPHABET.length]).join("");
}

function siteLanding(env: Env): Response {
  const origin = env.PUBLIC_APP_URL.replace(/\/$/, "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Replayr</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0c0f; --text:#e8eaed; --muted:#8b929c; --accent:#6cb4d4; --raised:#161a21; --border:#262b34; }
    body { margin:0; font: 16px/1.45 "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 720px; margin: 0 auto; padding: 48px 20px; }
    a { color: var(--accent); }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <p class="muted">Windows gameplay clipper</p>
    <h1>Capture on your PC. Share a cloud link.</h1>
    <p class="muted">Instant Replay lives on the desktop app. Cloud copies are unlisted by default. Shared links look like <code>${origin}/c/…</code> and never include a username.</p>
    <p class="muted">Open a share link to watch. Sign in on the web library to change visibility and copy links.</p>
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function shouldUpgradeToHttps(url: URL) {
  return url.protocol === "http:" && (url.hostname === "replayr.tv" || url.hostname === "www.replayr.tv");
}

function json(body: unknown, status = 200) {
  return cors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function cors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface AuthUser {
  id: string;
  token: string;
}

interface StorageRow {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

interface ClipRow {
  id: string;
  slug: string;
  storage_key: string | null;
  thumbnail_key?: string | null;
  status: string;
  file_size_bytes?: number | null;
}

interface LibraryRow {
  id: string;
  title: string | null;
  slug: string;
  status: string;
  visibility: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  created_at: string;
  storage_key: string | null;
  thumbnail_key: string | null;
}

interface GameRow {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  cover_url: string | null;
}

interface PublicClipRow {
  id: string;
  title: string | null;
  slug: string;
  duration_ms: number | null;
  created_at: string;
  storage_key: string | null;
  thumbnail_key: string | null;
  games: { name: string; slug: string; cover_url: string | null } | { name: string; slug: string; cover_url: string | null }[] | null;
}

interface PlaybackRow {
  id: string;
  slug: string;
  title: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  visibility: string;
  status: string;
  storage_key: string | null;
}
