import { handleAdmin } from "./admin";
import { handlePublicAnnouncements } from "./announcements";
import type { Env } from "./env";
import { ingestClientError, recordWorkerError } from "./errors";
import { cors, HttpError, json } from "./http";
import {
  anonymousAuthor,
  loadAuthors,
  loadSocial,
  lookupPlaybackRaw,
  objectUrl,
  optionalUser,
  ownedObjectKey,
  presentPublicClips,
  PUBLIC_CLIP_SELECT,
  r2Client,
  requireR2,
  requireServiceRole,
  requireUser,
  rest,
  restError,
  serviceRest,
  serviceRestCount,
  signedOwnedUrl,
  type AuthUser,
  type PlaybackRow,
  type PublicClipRow,
} from "./shared";
import { assertUploadAllowed, handleBilling } from "./billing";
import { handleSocial, hasConversationClipGrant } from "./social";

export type {
  AddMembersBody,
  ChatMessage,
  ConversationResponse,
  ConversationSummary,
  ConversationsResponse,
  CreateConversationBody,
  CreateFriendRequestBody,
  Friend,
  FriendRequest,
  FriendRequestsResponse,
  FriendsResponse,
  MessageClip,
  MessagesResponse,
  NotificationItem,
  NotificationsResponse,
  PostMessageBody,
  PublicClipCard,
  ReadNotificationsBody,
  ReadNotificationsResponse,
  Relationship,
  SendClipBody,
  SendClipResponse,
  SocialUser,
  FriendClipsResponse,
  UserProfileResponse,
  UserSuggestionsResponse,
  UsersSearchResponse,
} from "./social-types";

export type { Env } from "./env";

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
  async fetch(request: Request, env: Env, ctx: { waitUntil(task: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (shouldUpgradeToHttps(url)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), request);
    }
    try {
      return cors(await route(request, env, url, ctx), request);
    } catch (caught) {
      if (caught instanceof HttpError) {
        return cors(json({ error: caught.message }, caught.status), request);
      }
      const message = caught instanceof Error ? caught.message : "Worker failed.";
      ctx.waitUntil(recordWorkerError(env, message, url.pathname));
      return cors(json({ error: "Something went wrong." }, 500), request);
    }
  },
};

async function route(
  request: Request,
  env: Env,
  url: URL,
  ctx: { waitUntil(task: Promise<unknown>): void },
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return json({
      ok: true,
      storage: Boolean(env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID && env.R2_ACCOUNT_ID),
    });
  }
  const billing = await handleBilling(request, env, url);
  if (billing) return billing;
  const social = await handleSocial(request, env, url);
  if (social) return social;
  const announcements = await handlePublicAnnouncements(request, env, url);
  if (announcements) return announcements;
  if (request.method === "GET" && url.pathname === "/v1/library") {
    return listLibrary(request, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/clips/public") {
    return listPublicClips(request, env, url);
  }
  const gameClips = url.pathname.match(/^\/v1\/games\/([^/]+)\/clips$/);
  if (request.method === "GET" && gameClips?.[1]) {
    return listGameClips(request, env, gameClips[1]);
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
  const commentItem = url.pathname.match(/^\/v1\/clips\/([^/]+)\/comments\/([^/]+)$/);
  if (request.method === "DELETE" && commentItem?.[1] && commentItem[2]) {
    return deleteClipComment(request, env, commentItem[1], commentItem[2]);
  }
  const comments = url.pathname.match(/^\/v1\/clips\/([^/]+)\/comments$/);
  if (comments?.[1] && request.method === "GET") {
    return listClipComments(request, env, comments[1]);
  }
  if (comments?.[1] && request.method === "POST") {
    return addClipComment(request, env, comments[1]);
  }
  const like = url.pathname.match(/^\/v1\/clips\/([^/]+)\/like$/);
  if (like?.[1] && request.method === "POST") {
    return likeClip(request, env, like[1]);
  }
  if (like?.[1] && request.method === "DELETE") {
    return unlikeClip(request, env, like[1]);
  }
  const clipItem = url.pathname.match(/^\/v1\/clips\/([^/]+)$/);
  if (request.method === "DELETE" && clipItem?.[1]) {
    return deleteClip(request, env, clipItem[1]);
  }
  if (request.method === "GET" && clipItem?.[1]) {
    return getPlayback(request, env, clipItem[1], ctx);
  }
  if (request.method === "POST" && url.pathname === "/v1/account/delete") {
    return deleteAccount(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/errors") {
    return ingestClientError(request, env);
  }
  if (url.pathname.startsWith("/v1/admin")) {
    return handleAdmin(request, env, url);
  }
  const share = url.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (request.method === "GET" && share?.[1]) {
    return clipPlayerPage(request, env, share[1]);
  }
  if (request.method === "GET" && url.pathname === "/releases/latest.json") {
    return serveUpdaterManifest(request, env);
  }
  if (request.method === "GET" && url.pathname === "/") {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return siteLanding(env);
  }
  if (
    request.method === "GET" &&
    (url.pathname === "/library" ||
      url.pathname === "/explore" ||
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
  if (url.pathname.startsWith("/v1/")) {
    return json({ error: "Not found." }, 404);
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
    return json({ error: "This clip would exceed your cloud storage limit. Upgrade to Premium for 100 GB." }, 403);
  }
  const plan = await assertUploadAllowed(env, user.id, {
    durationMs: body.durationMs,
    width: body.width,
    height: body.height,
    fps: body.fps,
  });
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
    watermark: plan.watermark,
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

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const serviceKey = requireServiceRole(env);
  requireR2(env);

  let offset = 0;
  for (;;) {
    const clips = await serviceRest<ClipRow[]>(
      env,
      "GET",
      `/clips?user_id=eq.${user.id}&status=neq.deleted&select=id,user_id,storage_key,thumbnail_key,status,file_size_bytes&limit=100&offset=${offset}`,
    );
    if (clips.length === 0) break;
    const uploadingIds = clips.filter((clip) => clip.status === "uploading").map((clip) => clip.id);
    const reserved = new Map<string, number>();
    if (uploadingIds.length > 0) {
      const sessions = await serviceRest<{ clip_id: string; expected_size_bytes: number }[]>(
        env,
        "GET",
        `/upload_sessions?user_id=eq.${user.id}&clip_id=in.(${uploadingIds.join(",")})&select=clip_id,expected_size_bytes`,
      );
      for (const session of sessions) reserved.set(session.clip_id, session.expected_size_bytes);
    }
    for (const clip of clips) {
      await deleteOwnedObject(env, user.id, clip.storage_key);
      await deleteOwnedObject(env, user.id, clip.thumbnail_key);
      if (clip.status === "ready" && clip.file_size_bytes && clip.file_size_bytes > 0) {
        await releaseReservedBytes(env, user.id, clip.file_size_bytes);
      } else if (clip.status === "uploading") {
        await releaseReservedBytes(env, user.id, Number(reserved.get(clip.id) ?? NaN));
      }
    }
    if (clips.length < 100) break;
    offset += clips.length;
  }

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!response.ok) {
    throw new HttpError(502, restError(await response.text()) || "Could not delete this account.");
  }
  return json({ status: "deleted" });
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
    `/clips?${filter}&select=id,user_id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key,watermark&order=created_at.desc&limit=${limit}&offset=${offset}`,
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
      watermark: row.watermark !== false,
    });
  }
  return json({ clips, total, page, limit });
}

async function listGameClips(request: Request, env: Env, slug: string): Promise<Response> {
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
    `/clips?game_id=eq.${game.id}&visibility=eq.public&status=eq.ready&select=id,user_id,title,slug,status,visibility,duration_ms,width,height,file_size_bytes,created_at,storage_key,thumbnail_key,like_count,comment_count,watermark&order=created_at.desc&limit=48`,
  );
  requireR2(env);
  const viewer = await optionalUser(request, env);
  const social = await loadSocial(env, rows, viewer?.id ?? null);
  const clips = [];
  for (const row of rows) {
    const extra = social.get(row.id);
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
      thumbnailUrl: await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET"),
      playbackUrl: await signedOwnedUrl(env, row.user_id, row.storage_key, "GET"),
      author: extra?.author ?? anonymousAuthor(),
      likeCount: extra?.likeCount ?? row.like_count ?? 0,
      commentCount: extra?.commentCount ?? row.comment_count ?? 0,
      liked: extra?.liked ?? false,
      watermark: row.watermark !== false,
    });
  }
  return json({ game, clips });
}

async function listPublicClips(request: Request, env: Env, url: URL): Promise<Response> {
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(48, Math.floor(rawLimit)) : 24;
  const trending = url.searchParams.get("sort") === "trending";
  const rows = trending
    ? await listTrendingPublicRows(env, limit)
    : await serviceRest<PublicClipRow[]>(
        env,
        "GET",
        `/clips?visibility=eq.public&status=eq.ready&${PUBLIC_CLIP_SELECT}&order=created_at.desc&limit=${limit}`,
      );
  return json({ clips: await presentPublicClips(request, env, rows) });
}

async function listTrendingPublicRows(env: Env, limit: number): Promise<PublicClipRow[]> {
  const day = new Date().toISOString().slice(0, 10);
  const daily = await serviceRest<{ clip_id: string; count: number }[]>(
    env,
    "GET",
    `/clip_daily_views?day=eq.${day}&select=clip_id,count&order=count.desc&limit=${limit}`,
  );
  const rankedIds = daily.map((row) => row.clip_id);
  const fromToday = rankedIds.length
    ? await serviceRest<PublicClipRow[]>(
        env,
        "GET",
        `/clips?id=in.(${rankedIds.join(",")})&visibility=eq.public&status=eq.ready&${PUBLIC_CLIP_SELECT}`,
      )
    : [];
  const byId = new Map(fromToday.map((row) => [row.id, row]));
  const ordered = rankedIds.map((id) => byId.get(id)).filter((row): row is PublicClipRow => Boolean(row));
  if (ordered.length >= limit) return ordered.slice(0, limit);
  const exclude = ordered.map((row) => row.id);
  const filler = await serviceRest<PublicClipRow[]>(
    env,
    "GET",
    `/clips?visibility=eq.public&status=eq.ready&${PUBLIC_CLIP_SELECT}&order=view_count.desc,created_at.desc&limit=${limit}`,
  );
  for (const row of filler) {
    if (exclude.includes(row.id)) continue;
    ordered.push(row);
    if (ordered.length >= limit) break;
  }
  return ordered;
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

async function getPlayback(
  request: Request,
  env: Env,
  slug: string,
  ctx: { waitUntil(task: Promise<unknown>): void },
): Promise<Response> {
  const clip = await lookupPlayback(request, env, slug);
  if (!clip || !ownedObjectKey(clip.user_id, clip.storage_key)) {
    return json({ error: "That clip is not available." }, 404);
  }
  requireR2(env);
  const signed = await r2Client(env).sign(`${objectUrl(env, clip.storage_key)}?X-Amz-Expires=3600`, {
    method: "GET",
    aws: { signQuery: true },
  });
  const viewer = await optionalUser(request, env);
  if (clipAllowsSocial(clip) && viewer?.id !== clip.user_id) {
    ctx.waitUntil(recordClipView(env, clip.id, request));
  }
  const social = clipAllowsSocial(clip)
    ? await loadSocial(env, [clip], viewer?.id ?? null)
    : null;
  const extra = social?.get(clip.id);
  return json({
    id: clip.id,
    slug: clip.slug,
    title: clip.title,
    durationMs: clip.duration_ms,
    width: clip.width,
    height: clip.height,
    visibility: clip.visibility,
    status: clip.status,
    playbackUrl: signed.url,
    thumbnailUrl: await signedOwnedUrl(env, clip.user_id, clip.thumbnail_key, "GET"),
    author: extra?.author ?? anonymousAuthor(),
    likeCount: extra?.likeCount ?? clip.like_count ?? 0,
    commentCount: extra?.commentCount ?? clip.comment_count ?? 0,
    liked: extra?.liked ?? false,
    watermark: clip.watermark !== false,
  });
}

async function likeClip(request: Request, env: Env, slug: string): Promise<Response> {
  const user = await requireUser(request, env);
  const clip = await requireShareableClip(env, slug);
  try {
    await serviceRest(env, "POST", "/clip_likes", { clip_id: clip.id, user_id: user.id });
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
  }
  return json(await socialState(env, clip.id, user.id, true));
}

async function unlikeClip(request: Request, env: Env, slug: string): Promise<Response> {
  const user = await requireUser(request, env);
  const clip = await requireShareableClip(env, slug);
  await serviceRest(env, "DELETE", `/clip_likes?clip_id=eq.${clip.id}&user_id=eq.${user.id}`);
  return json(await socialState(env, clip.id, user.id, false));
}

async function listClipComments(request: Request, env: Env, slug: string): Promise<Response> {
  const clip = await requireShareableClip(env, slug);
  const rows = await serviceRest<CommentRow[]>(
    env,
    "GET",
    `/clip_comments?clip_id=eq.${clip.id}&select=id,user_id,body,created_at&order=created_at.asc&limit=80`,
  );
  const viewer = await optionalUser(request, env);
  const authors = await loadAuthors(
    env,
    rows.map((row) => row.user_id),
  );
  return json({
    comments: rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      mine: viewer?.id === row.user_id,
      canDelete: viewer?.id === row.user_id || viewer?.id === clip.user_id,
      author: authors.get(row.user_id) ?? anonymousAuthor(),
    })),
  });
}

async function addClipComment(request: Request, env: Env, slug: string): Promise<Response> {
  const user = await requireUser(request, env);
  const clip = await requireShareableClip(env, slug);
  const payload = (await request.json().catch(() => ({}))) as { body?: unknown };
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (body.length < 1 || body.length > 500) {
    throw new HttpError(400, "Comments must be 1–500 characters.");
  }
  await serviceRest(env, "POST", "/clip_comments", { clip_id: clip.id, user_id: user.id, body });
  const listed = await listClipComments(request, env, slug);
  const data = (await listed.json()) as { comments: unknown[] };
  const counts = await clipCounts(env, clip.id);
  return json({ comments: data.comments, commentCount: counts.commentCount });
}

async function deleteClipComment(request: Request, env: Env, slug: string, commentId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const clip = await requireShareableClip(env, slug);
  if (!/^[0-9a-f-]{36}$/i.test(commentId)) {
    throw new HttpError(404, "That comment was not found.");
  }
  const rows = await serviceRest<CommentRow[]>(
    env,
    "GET",
    `/clip_comments?id=eq.${commentId}&clip_id=eq.${clip.id}&select=id,user_id,body,created_at`,
  );
  const comment = rows[0];
  if (!comment) throw new HttpError(404, "That comment was not found.");
  if (comment.user_id !== user.id && clip.user_id !== user.id) {
    throw new HttpError(403, "You can only delete your own comment.");
  }
  await serviceRest(env, "DELETE", `/clip_comments?id=eq.${commentId}&clip_id=eq.${clip.id}`);
  const counts = await clipCounts(env, clip.id);
  return json({ deleted: true, commentCount: counts.commentCount });
}

function clipAllowsSocial(clip: { visibility: string }) {
  return clip.visibility === "public" || clip.visibility === "unlisted";
}

async function requireShareableClip(env: Env, slug: string): Promise<PlaybackRow> {
  const clip = await lookupPlaybackRaw(env, slug);
  if (!clip || !clipAllowsSocial(clip)) {
    throw new HttpError(404, "That clip is not available.");
  }
  return clip;
}

async function socialState(env: Env, clipId: string, userId: string, liked: boolean) {
  const counts = await clipCounts(env, clipId);
  return { liked, likeCount: counts.likeCount, commentCount: counts.commentCount };
}

async function clipCounts(env: Env, clipId: string) {
  const rows = await serviceRest<{ like_count: number; comment_count: number }[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&select=like_count,comment_count`,
  );
  return {
    likeCount: rows[0]?.like_count ?? 0,
    commentCount: rows[0]?.comment_count ?? 0,
  };
}

const recentViews = new Map<string, number>();

async function recordClipView(env: Env, clipId: string, request: Request): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const key = `${ip}:${clipId}`;
  const now = Date.now();
  const last = recentViews.get(key) ?? 0;
  if (now - last < 10 * 60 * 1000) return;
  recentViews.set(key, now);
  if (recentViews.size > 4000) {
    for (const [entry, at] of recentViews) {
      if (now - at > 10 * 60 * 1000) recentViews.delete(entry);
    }
  }
  try {
    await serviceRest(env, "POST", "/rpc/record_clip_view", { p_clip_id: clipId });
  } catch {
    recentViews.delete(key);
  }
}

async function lookupPlayback(request: Request, env: Env, slug: string): Promise<PlaybackRow | null> {
  const clip = await lookupPlaybackRaw(env, slug);
  if (!clip) return null;
  if (clip.visibility === "public" || clip.visibility === "unlisted") return clip;
  if (clip.visibility === "private") {
    const user = await optionalUser(request, env);
    if (!user) return null;
    if (user.id === clip.user_id) return clip;
    if (await hasConversationClipGrant(env, clip.id, user.id)) return clip;
  }
  return null;
}

async function serveUpdaterManifest(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    return json({ error: "Updater manifest is not published." }, 404);
  }
  const asset = await env.ASSETS.fetch(request);
  const text = await asset.text();
  const trimmed = text.trimStart();
  if (!asset.ok || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return json({ error: "Updater manifest is not published." }, 404);
  }
  try {
    JSON.parse(text);
  } catch {
    return json({ error: "Updater manifest is not published." }, 404);
  }
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache, must-revalidate",
      "cdn-cache-control": "no-store",
    },
  });
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
  like_count?: number;
  comment_count?: number;
  watermark?: boolean;
}

interface GameRow {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  cover_url: string | null;
}

interface CommentRow {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
}
