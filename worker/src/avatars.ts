import type { Env } from "./env";
import { clientFacingOrigin, HttpError, json } from "./http";
import { assertRateLimit } from "./rateLimit";
import {
  deleteR2Object,
  headR2Object,
  optionalUser,
  putR2Object,
  requireR2,
  requireUser,
  serviceRest,
  signedObjectUrl,
} from "./shared";
import { AVATAR_MAX_BYTES, AVATAR_MIMES, avatarKey, isOwnedAvatarKey, sniffAvatarMime } from "./staffAttachmentRules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAvatars(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (method === "POST" && path === "/v1/me/avatar") {
    const contentType = (request.headers.get("content-type") || "").toLowerCase().split(";")[0]!.trim();
    if (AVATAR_MIMES[contentType]) {
      return uploadAvatar(request, env, url);
    }
    throw new HttpError(400, "Send a JPG, PNG, or WebP image.");
  }

  if (method === "DELETE" && path === "/v1/me/avatar") {
    const user = await requireUser(request, env);
    const previous = await serviceRest<Array<{ avatar_url: string | null }>>(
      env,
      "GET",
      `/profiles?id=eq.${user.id}&select=avatar_url`,
    );
    await serviceRest(env, "PATCH", `/profiles?id=eq.${user.id}`, { avatar_url: null });
    await deletePreviousAvatar(env, user.id, previous[0]?.avatar_url, null);
    return json({ ok: true });
  }

  const publicAvatar = path.match(/^\/v1\/avatars\/([^/]+)$/);
  if ((method === "GET" || method === "HEAD") && publicAvatar?.[1] && UUID.test(publicAvatar[1])) {
    return serveAvatar(request, env, url, publicAvatar[1]);
  }

  return null;
}

async function uploadAvatar(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  assertRateLimit(request, "avatar-upload", 10, user.id);
  requireR2(env);
  const declared = (request.headers.get("content-type") || "").toLowerCase().split(";")[0]!.trim();
  const declaredExt = AVATAR_MIMES[declared];
  if (!declaredExt) throw new HttpError(400, "Use a JPG, PNG, or WebP image.");
  const length = Number(request.headers.get("content-length") || 0);
  if (length > AVATAR_MAX_BYTES) throw new HttpError(400, "Avatar must be 5 MB or smaller.");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new HttpError(400, "Avatar must be 5 MB or smaller.");
  }
  const sniffed = sniffAvatarMime(bytes);
  if (!sniffed || AVATAR_MIMES[sniffed] !== declaredExt) {
    throw new HttpError(400, "File contents do not match the image type.");
  }
  const objectId = crypto.randomUUID();
  const storageKey = avatarKey(user.id, objectId, declaredExt);
  const previous = await serviceRest<Array<{ avatar_url: string | null }>>(
    env,
    "GET",
    `/profiles?id=eq.${user.id}&select=avatar_url`,
  );
  await putR2Object(env, storageKey, bytes, sniffed);
  const publicUrl = avatarPublicUrl(request, url, user.id, storageKey, Date.now());
  await serviceRest(env, "PATCH", `/profiles?id=eq.${user.id}`, { avatar_url: publicUrl });
  await deletePreviousAvatar(env, user.id, previous[0]?.avatar_url, storageKey);
  return json({ avatarUrl: publicUrl, storageKey });
}

async function serveAvatar(request: Request, env: Env, url: URL, userId: string): Promise<Response> {
  const viewer = await optionalUser(request, env);
  const profiles = await serviceRest<Array<{ id: string; avatar_url: string | null; is_private: boolean }>>(
    env,
    "GET",
    `/profiles?id=eq.${userId}&select=id,avatar_url,is_private`,
  );
  const profile = profiles[0];
  if (!profile?.avatar_url) throw new HttpError(404, "No avatar.");
  if (profile.is_private && viewer?.id !== userId) throw new HttpError(404, "No avatar.");
  const key = resolveAvatarKey(userId, url, profile.avatar_url);
  if (!key) throw new HttpError(404, "No avatar.");
  if (!(await headR2Object(env, key))) throw new HttpError(404, "No avatar.");
  const signed = await signedObjectUrl(env, key, "GET", undefined, 300);
  return Response.redirect(signed, 302);
}

function avatarPublicUrl(request: Request, url: URL, userId: string, storageKey: string, version: number): string {
  const name = storageKey.split("/").pop() || "";
  const origin = clientFacingOrigin(request, url.origin);
  return `${origin}/v1/avatars/${userId}?o=${encodeURIComponent(name)}&v=${version}`;
}

function resolveAvatarKey(userId: string, url: URL, storedUrl: string): string | null {
  const name = url.searchParams.get("o") || objectNameFromAvatarUrl(storedUrl);
  if (!name) return null;
  const key = `avatars/${userId}/${name}`;
  return isOwnedAvatarKey(userId, key) ? key : null;
}

function objectNameFromAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).searchParams.get("o");
  } catch {
    return null;
  }
}

async function deletePreviousAvatar(env: Env, userId: string, previousUrl: string | null | undefined, keepKey: string | null) {
  if (env.CLIPS) {
    const listed = await env.CLIPS.list({ prefix: `avatars/${userId}/` });
    for (const object of listed.objects) {
      if (keepKey && object.key === keepKey) continue;
      if (!isOwnedAvatarKey(userId, object.key)) continue;
      await env.CLIPS.delete(object.key);
    }
    return;
  }
  const previousName = objectNameFromAvatarUrl(previousUrl);
  if (!previousName) return;
  const previousKey = `avatars/${userId}/${previousName}`;
  if (!isOwnedAvatarKey(userId, previousKey) || previousKey === keepKey) return;
  await deleteR2Object(env, previousKey);
}
