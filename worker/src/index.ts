import { AwsClient } from "aws4fetch";
import { handleAdmin } from "./admin";
import { cors, HttpError, json } from "./http";

export interface Env {
  CLIPS?: R2Bucket;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
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
      return cors(new Response(null, { status: 204 }), request);
    }
    try {
      return cors(await route(request, env, url), request);
    } catch (caught) {
      if (caught instanceof HttpError) {
        return cors(json({ error: caught.message }, caught.status), request);
      }
      const message = caught instanceof Error ? caught.message : "Worker failed.";
      return cors(json({ error: message }, 500), request);
    }
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return json({
      ok: true,
      storage: Boolean(env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID && env.R2_ACCOUNT_ID),
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/library") {
    return listLibrary(request, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/clips/public") {
    return listPublicClips(env);
  }
  const gameClips = url.pathname.match(/^\/v1\/games\/([^/]+)\/clips$/);
  if (request.method === "GET" && gameClips?.[1]) {
    return listGameClips(env, gameClips[1]);
  }
  if (request.method === "POST" && url.pathname === "/v1/clips/uploads") {
    return createUpload(request, env);
  }
  const complete = url.pathname.match(/^\/v1\/clips\/([^/]+)\/complete$/);
  if (request.method === "POST" && complete?.[1]) {
    return completeUpload(request, env, complete[1]);
  }
  const download = url.pathname.match(/^\/v1\/clips\/([^/]+)\/download$/);
  if (request.method === "GET" && download?.[1]) {
    return downloadClip(request, env, download[1]);
  }
  const clipItem = url.pathname.match(/^\/v1\/clips\/([^/]+)$/);
  if (request.method === "DELETE" && clipItem?.[1]) {
    return deleteClip(request, env, clipItem[1]);
  }
  if (request.method === "GET" && clipItem?.[1]) {
    return getPlayback(request, env, clipItem[1]);
  }
  if (url.pathname.startsWith("/v1/admin")) {
    return handleAdmin(request, env, url);
  }
  const share = url.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (request.method === "GET" && share?.[1]) {
    return clipPlayerPage(request, env, share[1]);
  }
  if (request.method === "GET" && url.pathname === "/") {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return siteLanding(env);
  }
  if (
    request.method === "GET" &&
    (url.pathname === "/library" ||
      url.pathname === "/signin" ||
      url.pathname === "/auth/callback" ||
      url.pathname === "/auth/desktop" ||
      url.pathname === "/admin" ||
      url.pathname.startsWith("/admin/"))
  ) {
    if (env.ASSETS) {
      const index = new URL("/index.html", request.url);
      return env.ASSETS.fetch(new Request(index, request));
    }
  }
  if (env.ASSETS && request.method === "GET") {
    return env.ASSETS.fetch(request);
  }
  return json({ error: "Not found." }, 404);
}

async function createUpload(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  requireR2(env);
  const body = (await request.json()) as UploadBody;
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return json({ error: "Clip file size is required." }, 400);
  }

  await releaseExpiredUploads(env, user.id);

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
  const openSessions = await serviceRestCount(
    env,
    `/upload_sessions?user_id=eq.${user.id}&status=eq.uploading&expires_at=gt.${new Date().toISOString()}&select=id`,
  );
  if (openSessions >= 5) {
    return json({ error: "Finish or wait for an existing upload before starting another." }, 429);
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
      await failClip(env, user.id, clipId);
      return json({ error: `Could not start multipart upload: ${xml}` }, 502);
    }
    uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1] ?? null;
    if (!uploadId) {
      await failClip(env, user.id, clipId);
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

  try {
    await reserveUploadBytes(env, user.id, size);
  } catch (caught) {
    await abortMultipart(env, key, uploadId);
    await failClip(env, user.id, clipId);
    throw caught;
  }

  try {
    await serviceRest(env, "POST", "/upload_sessions", {
      clip_id: clipId,
      user_id: user.id,
      storage_key: key,
      multipart_upload_id: uploadId,
      expected_size_bytes: size,
      declared_content_type: CONTENT_TYPE,
      status: "uploading",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (caught) {
    await releaseReservedBytes(env, user.id, size);
    await abortMultipart(env, key, uploadId);
    await failClip(env, user.id, clipId);
    throw caught;
  }

  return json({
    clipId,
    slug,
    key,
    thumbKey,
    thumbUrl: await signedOwnedUrl(env, user.id, thumbKey, "PUT", { "content-type": "image/bmp" }),
    uploadId,
    partSize: PART_SIZE,
    parts,
  });
}

async function completeUpload(request: Request, env: Env, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  requireR2(env);
  await releaseExpiredUploads(env, user.id);
  const body = (await request.json()) as CompleteBody;
  const clips = await serviceRest<ClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&user_id=eq.${user.id}&select=id,user_id,slug,storage_key,status`,
  );
  const clip = clips[0];
  if (!clip) {
    return json({ error: "Clip upload was not found." }, 404);
  }
  if (clip.status === "ready") {
    return json({
      clipId,
      slug: clip.slug,
      status: "ready",
      shareUrl: `${publicShareOrigin(env)}/c/${clip.slug}`,
    });
  }
  if (clip.status !== "uploading") {
    return json({ error: "Clip upload was not found." }, 404);
  }
  if (!ownedObjectKey(user.id, clip.storage_key)) {
    await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, { status: "failed" });
    return json({ error: "Clip storage key is invalid." }, 403);
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

  const sessions = await serviceRest<{ expected_size_bytes: number }[]>(
    env,
    "GET",
    `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}&select=expected_size_bytes`,
  );
  const expected = Number(sessions[0]?.expected_size_bytes ?? NaN);
  const size = await objectSize(env, clip.storage_key);
  if (size == null || size <= 0 || !Number.isFinite(expected) || size !== expected) {
    await deleteOwnedObject(env, user.id, clip.storage_key);
    await releaseReservedBytes(env, user.id, expected);
    await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, { status: "failed" });
    await serviceRest(env, "PATCH", `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}`, {
      status: "aborted",
    });
    return json({ error: "Uploaded object was not found in cloud storage." }, 400);
  }

  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, {
    status: "ready",
    file_size_bytes: size,
  });
  await serviceRest(env, "PATCH", `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}`, {
    status: "completed",
  });

  return json({
    clipId,
    slug: clip.slug,
    status: "ready",
    shareUrl: `${publicShareOrigin(env)}/c/${clip.slug}`,
  });
}

async function deleteClip(request: Request, env: Env, clipId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clipId)) {
    return json({ error: "Clip id is invalid." }, 400);
  }
  const user = await requireUser(request, env);
  const clips = await serviceRest<ClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&user_id=eq.${user.id}&select=id,user_id,slug,storage_key,thumbnail_key,status,file_size_bytes`,
  );
  const clip = clips[0];
  if (!clip || clip.status === "deleted") {
    return json({ error: "That cloud clip was not found." }, 404);
  }

  const sessions =
    clip.status === "uploading"
      ? await serviceRest<{ expected_size_bytes: number }[]>(
          env,
          "GET",
          `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}&select=expected_size_bytes`,
        )
      : [];

  if (clip.storage_key || clip.thumbnail_key) requireR2(env);
  await deleteOwnedObject(env, user.id, clip.storage_key);
  await deleteOwnedObject(env, user.id, clip.thumbnail_key);

  if (clip.status === "ready" && clip.file_size_bytes && clip.file_size_bytes > 0) {
    await releaseReservedBytes(env, user.id, clip.file_size_bytes);
  } else if (clip.status === "uploading") {
    await releaseReservedBytes(env, user.id, Number(sessions[0]?.expected_size_bytes ?? NaN));
  }

  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${user.id}`, {
    status: "deleted",
    storage_key: null,
    thumbnail_key: null,
  });
  await serviceRest(env, "DELETE", `/upload_sessions?clip_id=eq.${clipId}&user_id=eq.${user.id}`);

  return json({ clipId, status: "deleted" });
}

async function listLibrary(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const url = new URL(request.url);
  const rawPage = Number(url.searchParams.get("page"));
  const rawLimit = Number(url.searchParams.get("limit"));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(48, Math.floor(rawLimit)) : 24;
  const offset = (page - 1) * limit;
  const filter = `user_id=eq.${user.id}&status=in.(ready,uploading)`;
  const total = await serviceRestCount(env, `/clips?${filter}&select=id`);
  const rows = await serviceRest<LibraryRow[]>(
    env,
    "GET",
    `/clips?${filter}&select=id,user_id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key&order=created_at.desc&limit=${limit}&offset=${offset}`,
  );
  requireR2(env);
  const clips = [];
  for (const row of rows) {
    const thumbnailUrl =
      row.status === "ready" ? await signedOwnedUrl(env, user.id, row.thumbnail_key, "GET") : null;
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
      playbackUrl:
        row.status === "ready" && !thumbnailUrl
          ? await signedOwnedUrl(env, user.id, row.storage_key, "GET")
          : null,
    });
  }
  return json({ clips, total, page, limit });
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
  const rows = await serviceRest<LibraryRow[]>(
    env,
    "GET",
    `/clips?game_id=eq.${game.id}&visibility=eq.public&status=eq.ready&select=id,user_id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key&order=created_at.desc&limit=48`,
  );
  requireR2(env);
  const clips = [];
  for (const row of rows) {
    const thumbnailUrl = await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET");
    const playbackUrl = await signedOwnedUrl(env, row.user_id, row.storage_key, "GET");
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
  const rows = await serviceRest<PublicClipRow[]>(
    env,
    "GET",
    "/clips?visibility=eq.public&status=eq.ready&select=id,user_id,title,slug,duration_ms,created_at,storage_key,thumbnail_key,games(name,slug,cover_url)&order=created_at.desc&limit=12",
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
      thumbnailUrl: await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET"),
      playbackUrl: await signedOwnedUrl(env, row.user_id, row.storage_key, "GET"),
      game: game
        ? { name: game.name, slug: game.slug, coverUrl: game.cover_url }
        : null,
    });
  }
  return json({ clips });
}

async function downloadClip(request: Request, env: Env, slug: string): Promise<Response> {
  const clip = await lookupPlayback(request, env, slug);
  if (!clip || !ownedObjectKey(clip.user_id, clip.storage_key)) {
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
  if (!clip || !ownedObjectKey(clip.user_id, clip.storage_key)) {
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
    thumbnailUrl: await signedOwnedUrl(env, clip.user_id, clip.thumbnail_key, "GET"),
  });
}

async function lookupPlayback(request: Request, env: Env, slug: string): Promise<PlaybackRow | null> {
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return null;
  const rows = await serviceRest<PlaybackRow[]>(
    env,
    "GET",
    `/clips?slug=eq.${slug}&status=eq.ready&select=id,user_id,slug,title,duration_ms,width,height,visibility,status,storage_key,thumbnail_key`,
  );
  const clip = rows[0];
  if (!clip || !ownedObjectKey(clip.user_id, clip.storage_key)) return null;
  if (clip.visibility === "public" || clip.visibility === "unlisted") return clip;
  if (clip.visibility === "private") {
    const user = await optionalUser(request, env);
    if (user?.id === clip.user_id) return clip;
  }
  return null;
}

async function optionalUser(request: Request, env: Env): Promise<AuthUser | null> {
  try {
    if (!bearerToken(request)) return null;
    return await requireUser(request, env);
  } catch {
    return null;
  }
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
  const origin = publicShareOrigin(env) || new URL(request.url).origin;
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
      await serviceRest(env, "POST", "/clips", { ...row, slug });
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

function requireServiceRole(env: Env): string {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Cloud quota is not configured on the Worker.");
  }
  return env.SUPABASE_SERVICE_ROLE_KEY;
}

export function ownedObjectKey(userId: string, key: string | null | undefined): key is string {
  return Boolean(
    key &&
      key.startsWith(`clips/${userId}/`) &&
      !key.includes("..") &&
      /^clips\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(original\.mp4|thumb)$/i.test(key),
  );
}

async function deleteOwnedObject(env: Env, userId: string, key: string | null | undefined) {
  if (!ownedObjectKey(userId, key)) return;
  if (env.CLIPS) await env.CLIPS.delete(key);
  else await r2Client(env).fetch(objectUrl(env, key), { method: "DELETE" });
}

async function releaseExpiredUploads(env: Env, userId: string) {
  const expired = await serviceRest<{ clip_id: string; expected_size_bytes: number }[]>(
    env,
    "GET",
    `/upload_sessions?user_id=eq.${userId}&status=eq.uploading&expires_at=lt.${new Date().toISOString()}&select=clip_id,expected_size_bytes`,
  );
  for (const session of expired) {
    await releaseReservedBytes(env, userId, Number(session.expected_size_bytes));
    await failClip(env, userId, session.clip_id);
    await serviceRest(env, "DELETE", `/upload_sessions?clip_id=eq.${session.clip_id}&user_id=eq.${userId}`);
  }
}

async function reserveUploadBytes(env: Env, userId: string, bytes: number) {
  try {
    await serviceRest(env, "POST", "/rpc/add_storage_used_for", { p_user_id: userId, p_bytes: bytes });
  } catch (caught) {
    throw quotaHttpError(caught) ?? caught;
  }
}

async function releaseReservedBytes(env: Env, userId: string, bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  await serviceRest(env, "POST", "/rpc/release_storage_used_for", { p_user_id: userId, p_bytes: bytes });
}

async function failClip(env: Env, userId: string, clipId: string) {
  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}&user_id=eq.${userId}`, { status: "failed" });
}

async function abortMultipart(env: Env, key: string, uploadId: string | null) {
  if (!uploadId) return;
  try {
    await r2Client(env).fetch(`${objectUrl(env, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
  } catch {
    /* best-effort abort */
  }
}

function quotaHttpError(caught: unknown): HttpError | null {
  if (!(caught instanceof HttpError)) return null;
  if (/exceed your cloud storage/i.test(caught.message)) {
    return new HttpError(403, "This clip would exceed your cloud storage limit.");
  }
  if (/No storage plan/i.test(caught.message)) {
    return new HttpError(403, "No storage plan is attached to this account.");
  }
  return null;
}

async function signedOwnedUrl(
  env: Env,
  userId: string,
  key: string | null | undefined,
  method: "GET" | "PUT",
  headers?: Record<string, string>,
): Promise<string | null> {
  if (!ownedObjectKey(userId, key)) return null;
  return (await signObject(env, key, method, headers)).url;
}

async function serviceRestCount(env: Env, path: string): Promise<number> {
  const key = requireServiceRole(env);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
      range: "0-0",
    },
  });
  if (!response.ok) {
    throw new HttpError(502, restError(await response.text()) || "Supabase request failed.");
  }
  const total = response.headers.get("content-range")?.split("/")[1];
  return total && total !== "*" ? Number(total) : 0;
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
  return restFetch<T>(env, env.SUPABASE_ANON_KEY, token, method, path, body);
}

async function serviceRest<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const key = requireServiceRole(env);
  return restFetch<T>(env, key, key, method, path, body);
}

async function restFetch<T>(
  env: Env,
  apikey: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey,
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
  const origin = publicShareOrigin(env);
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

function publicShareOrigin(env: Env) {
  const origin = (env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  try {
    const host = new URL(origin).hostname;
    if (host === "127.0.0.1" || host === "localhost") return "https://replayr.tv";
  } catch {
    /* keep configured origin */
  }
  return origin || "https://replayr.tv";
}

function shouldUpgradeToHttps(url: URL) {
  if (url.pathname.startsWith("/v1/")) return false;
  return url.protocol === "http:" && (url.hostname === "replayr.tv" || url.hostname === "www.replayr.tv");
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
  user_id?: string;
  slug: string;
  storage_key: string | null;
  thumbnail_key?: string | null;
  status: string;
  file_size_bytes?: number | null;
}

interface LibraryRow {
  id: string;
  user_id: string;
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
  user_id: string;
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
  user_id: string;
  slug: string;
  title: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  visibility: string;
  status: string;
  storage_key: string | null;
  thumbnail_key?: string | null;
}
