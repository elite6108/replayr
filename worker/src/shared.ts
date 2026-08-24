import { AwsClient } from "aws4fetch";
import type { AuthUser, Env } from "./env";
import { HttpError } from "./http";

export type { AuthUser, Env } from "./env";

export const PUBLIC_CLIP_SELECT =
  "select=id,user_id,title,description,slug,duration_ms,created_at,view_count,storage_key,thumbnail_key,like_count,comment_count,games(name,slug,cover_url)";

export interface PublicClipRow {
  id: string;
  user_id: string;
  title: string | null;
  description?: string | null;
  slug: string;
  duration_ms: number | null;
  created_at: string;
  view_count?: number;
  storage_key: string | null;
  thumbnail_key: string | null;
  like_count?: number;
  comment_count?: number;
  games:
    | { name: string; slug: string; cover_url: string | null }
    | { name: string; slug: string; cover_url: string | null }[]
    | null;
}

export interface PlaybackRow {
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
  like_count?: number;
  comment_count?: number;
}

interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean;
}

interface ClipAuthor {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  verified?: boolean;
}

export async function requireUser(request: Request, env: Env): Promise<AuthUser> {
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

export async function optionalUser(request: Request, env: Env): Promise<AuthUser | null> {
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

export function ownedObjectKey(userId: string, key: string | null | undefined): key is string {
  return Boolean(
    key &&
      key.startsWith(`clips/${userId}/`) &&
      !key.includes("..") &&
      /^clips\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(original\.mp4|thumb)$/i.test(key),
  );
}

export function requireR2(env: Env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new HttpError(503, "Cloud storage is not configured on the Worker.");
  }
}

export function requireServiceRole(env: Env): string {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Cloud quota is not configured on the Worker.");
  }
  return env.SUPABASE_SERVICE_ROLE_KEY;
}

export function r2Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

export function objectUrl(env: Env, key: string) {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
}

function signObject(env: Env, key: string, method: "GET" | "PUT", headers?: Record<string, string>) {
  return r2Client(env).sign(`${objectUrl(env, key)}?X-Amz-Expires=3600`, {
    method,
    headers,
    aws: { signQuery: true },
  });
}

export async function signedOwnedUrl(
  env: Env,
  userId: string,
  key: string | null | undefined,
  method: "GET" | "PUT",
  headers?: Record<string, string>,
): Promise<string | null> {
  if (!ownedObjectKey(userId, key)) return null;
  return (await signObject(env, key, method, headers)).url;
}

export async function serviceRestCount(env: Env, path: string): Promise<number> {
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

export async function rest<T>(env: Env, token: string, method: string, path: string, body?: unknown): Promise<T> {
  return restFetch<T>(env, env.SUPABASE_ANON_KEY, token, method, path, body);
}

export async function serviceRest<T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  prefer?: string,
): Promise<T> {
  const key = requireServiceRole(env);
  return restFetch<T>(env, key, key, method, path, body, prefer);
}

async function restFetch<T>(
  env: Env,
  apikey: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  prefer?: string,
): Promise<T> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer:
        prefer ??
        (method === "POST" && path.startsWith("/rpc/")
          ? "return=representation"
          : method === "POST" || method === "DELETE"
            ? "return=minimal"
            : "return=representation"),
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

export function restError(body: string): string {
  try {
    const value = JSON.parse(body) as { message?: string; hint?: string; details?: string };
    return value.message || value.hint || value.details || body;
  } catch {
    return body;
  }
}

export async function lookupPlaybackRaw(env: Env, slug: string): Promise<PlaybackRow | null> {
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return null;
  const rows = await serviceRest<PlaybackRow[]>(
    env,
    "GET",
    `/clips?slug=eq.${slug}&status=eq.ready&select=id,user_id,slug,title,duration_ms,width,height,visibility,status,storage_key,thumbnail_key,like_count,comment_count`,
  );
  const clip = rows[0];
  if (!clip || !ownedObjectKey(clip.user_id, clip.storage_key)) return null;
  return clip;
}

export async function presentPublicClips(request: Request, env: Env, rows: PublicClipRow[]) {
  requireR2(env);
  const viewer = await optionalUser(request, env);
  const social = await loadSocial(env, rows, viewer?.id ?? null);
  const clips = [];
  for (const row of rows) {
    const game = Array.isArray(row.games) ? row.games[0] : row.games;
    const extra = social.get(row.id);
    clips.push({
      id: row.id,
      title: row.title,
      description: row.description,
      slug: row.slug,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      viewCount: row.view_count ?? 0,
      thumbnailUrl: await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET"),
      playbackUrl: await signedOwnedUrl(env, row.user_id, row.storage_key, "GET"),
      game: game ? { name: game.name, slug: game.slug, coverUrl: game.cover_url } : null,
      author: extra?.author ?? anonymousAuthor(),
      likeCount: extra?.likeCount ?? row.like_count ?? 0,
      commentCount: extra?.commentCount ?? row.comment_count ?? 0,
      liked: extra?.liked ?? false,
    });
  }
  return clips;
}

export async function loadSocial(
  env: Env,
  rows: { id: string; user_id: string; like_count?: number; comment_count?: number }[],
  viewerId: string | null,
): Promise<Map<string, { author: ClipAuthor; likeCount: number; commentCount: number; liked: boolean }>> {
  const result = new Map<string, { author: ClipAuthor; likeCount: number; commentCount: number; liked: boolean }>();
  if (rows.length === 0) return result;
  const authors = await loadAuthors(
    env,
    rows.map((row) => row.user_id),
  );
  const liked = viewerId ? await likedClipIds(env, viewerId, rows.map((row) => row.id)) : new Set<string>();
  for (const row of rows) {
    result.set(row.id, {
      author: authors.get(row.user_id) ?? anonymousAuthor(),
      likeCount: row.like_count ?? 0,
      commentCount: row.comment_count ?? 0,
      liked: liked.has(row.id),
    });
  }
  return result;
}

export async function loadAuthors(env: Env, userIds: string[]): Promise<Map<string, ClipAuthor>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const authors = new Map<string, ClipAuthor>();
  if (unique.length === 0) return authors;
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?id=in.(${unique.join(",")})&select=id,username,display_name,avatar_url,is_verified`,
  );
  for (const row of rows) {
    authors.set(row.id, {
      username: row.username,
      displayName: row.display_name || row.username,
      avatarUrl: row.avatar_url,
      verified: Boolean(row.is_verified),
    });
  }
  return authors;
}

async function likedClipIds(env: Env, userId: string, clipIds: string[]): Promise<Set<string>> {
  if (clipIds.length === 0) return new Set();
  const rows = await serviceRest<{ clip_id: string }[]>(
    env,
    "GET",
    `/clip_likes?user_id=eq.${userId}&clip_id=in.(${clipIds.join(",")})&select=clip_id`,
  );
  return new Set(rows.map((row) => row.clip_id));
}

export function anonymousAuthor(): ClipAuthor {
  return { username: null, displayName: "Player", avatarUrl: null, verified: false };
}
