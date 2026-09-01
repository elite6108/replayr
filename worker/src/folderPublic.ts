import { observeServerAnalytics, SERVER_ANALYTICS_EVENTS } from "./analytics";
import { recordFolderPublicDownloadEvent } from "./analyticsDownloads";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { recordProductEvent } from "./metrics";
import { assertRateLimit } from "./rateLimit";
import {
  FOLDER_SELECT,
  FOLDER_UUID,
  generatePublicFolderToken,
  hashPublicFolderToken,
  loadFolderClipRows,
  loadProfileCards,
  originFromEnv,
  PUBLIC_FOLDER_TOKEN,
  publicFolderUrl,
  requireFolderPermission,
  type FolderClipRow,
  type FolderRow,
} from "./folders";
import { requireR2, requireUser, serviceRest, signedOwnedUrl } from "./shared";
import type { PublicFolder, PublicFolderClip, PublicFolderOwner } from "./social-types";

const PUBLIC_PLAYBACK_TTL = 900;
const PUBLIC_DOWNLOAD_TTL = 600;
const CLIP_MEDIA_SELECT = "id,user_id,title,status,visibility,duration_ms,created_at,storage_key,thumbnail_key";

type SecretRow = { folder_id: string; token: string };
type MediaClipRow = {
  id: string;
  user_id: string;
  title: string | null;
  status: string;
  visibility: string;
  duration_ms: number | null;
  created_at: string;
  storage_key: string | null;
  thumbnail_key: string | null;
};

const NOT_FOUND = "That folder was not found.";

export async function handleFolderPublicLink(request: Request, env: Env, url: URL): Promise<Response | null> {
  const regenerate = url.pathname.match(/^\/v1\/folders\/([^/]+)\/public-link\/regenerate$/);
  if (regenerate?.[1] && request.method === "POST") {
    return regeneratePublicLink(request, env, regenerate[1]);
  }
  const link = url.pathname.match(/^\/v1\/folders\/([^/]+)\/public-link$/);
  if (link?.[1] && request.method === "POST") return enablePublicLink(request, env, link[1]);
  if (link?.[1] && request.method === "DELETE") return disablePublicLink(request, env, link[1]);
  if (link?.[1] && request.method === "PATCH") return updatePublicLink(request, env, link[1]);
  return null;
}

export async function handlePublicFolders(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/public/folders")) return null;
  const download = url.pathname.match(/^\/v1\/public\/folders\/([^/]+)\/clips\/([^/]+)\/download$/);
  if (download?.[1] && download[2] && request.method === "GET") {
    assertRateLimit(request, "public-folder-download", 20);
    return publicFolderDownload(env, download[1], download[2]);
  }
  const playback = url.pathname.match(/^\/v1\/public\/folders\/([^/]+)\/clips\/([^/]+)\/playback$/);
  if (playback?.[1] && playback[2] && request.method === "GET") {
    assertRateLimit(request, "public-folder-play", 60);
    return publicFolderPlayback(env, playback[1], playback[2]);
  }
  const one = url.pathname.match(/^\/v1\/public\/folders\/([^/]+)$/);
  if (one?.[1] && request.method === "GET") {
    assertRateLimit(request, "public-folder", 60);
    return getPublicFolder(env, one[1]);
  }
  return json({ error: NOT_FOUND }, 404);
}

async function enablePublicLink(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "managePublicShare");
  const wasEnabled = access.folder.public_enabled;
  if (access.folder.public_enabled && access.folder.public_token_hash) {
    const token = await loadSecretToken(env, folderId);
    if (token) return json({ publicShare: sharePayload(access.folder, token, env) });
  }
  const token = generatePublicFolderToken();
  const folder = await persistPublicLink(env, access.folder, token, {
    enabled: true,
    rotate: !access.folder.public_enabled,
  });
  void recordProductEvent(env, "folder_public_link", 1, { action: "enable", folderId, userId: user.id });
  if (!wasEnabled && folder.public_enabled) {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.folderPublicLinkEnabled, {
      userId: user.id,
      entityId: folder.id,
    });
    const { AUDIT_ACTIONS, requestCorrelationId, writeAuditLog } = await import("./audit");
    void writeAuditLog(env, {
      actorUserId: user.id,
      actorType: "user",
      action: AUDIT_ACTIONS.folderPublicLinkEnabled,
      targetType: "folder",
      targetId: folderId,
      requestId: requestCorrelationId(request),
    });
  }
  return json({ publicShare: sharePayload(folder, token, env) }, wasEnabled ? 200 : 201);
}

async function disablePublicLink(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "managePublicShare");
  if (!access.folder.public_enabled && !access.folder.public_token_hash) {
    return json({
      publicShare: { enabled: false, url: null, allowDownloads: Boolean(access.folder.allow_public_downloads) },
    });
  }
  const folder = await persistPublicLink(env, access.folder, null, { enabled: false, rotate: true });
  void recordProductEvent(env, "folder_public_link", 1, { action: "disable", folderId, userId: user.id });
  const { AUDIT_ACTIONS, requestCorrelationId, writeAuditLog } = await import("./audit");
  void writeAuditLog(env, {
    actorUserId: user.id,
    actorType: "user",
    action: AUDIT_ACTIONS.folderPublicLinkDisabled,
    targetType: "folder",
    targetId: folderId,
    requestId: requestCorrelationId(request),
  });
  return json({ publicShare: sharePayload(folder, null, env) });
}

async function regeneratePublicLink(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "managePublicShare");
  if (!access.folder.public_enabled) {
    throw new HttpError(400, "Public link is disabled.");
  }
  const token = generatePublicFolderToken();
  const folder = await persistPublicLink(env, access.folder, token, { enabled: true, rotate: true });
  void recordProductEvent(env, "folder_public_link", 1, { action: "regenerate", folderId, userId: user.id });
  const { AUDIT_ACTIONS, requestCorrelationId, writeAuditLog } = await import("./audit");
  void writeAuditLog(env, {
    actorUserId: user.id,
    actorType: "user",
    action: AUDIT_ACTIONS.folderPublicLinkRegenerated,
    targetType: "folder",
    targetId: folderId,
    requestId: requestCorrelationId(request),
  });
  return json({ publicShare: sharePayload(folder, token, env) });
}

async function updatePublicLink(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "managePublicShare");
  const body = (await request.json().catch(() => ({}))) as { allowDownloads?: unknown };
  if (typeof body.allowDownloads !== "boolean") {
    throw new HttpError(400, "Set allowDownloads to true or false.");
  }
  const rows = await serviceRest<FolderRow[]>(
    env,
    "PATCH",
    `/folders?id=eq.${folderId}`,
    { allow_public_downloads: body.allowDownloads },
    "return=representation",
  );
  const folder = rows[0] ?? { ...access.folder, allow_public_downloads: body.allowDownloads };
  const token = folder.public_enabled ? await loadSecretToken(env, folderId) : null;
  void recordProductEvent(env, "folder_public_link", 1, {
    action: "downloads",
    folderId,
    userId: user.id,
    allowDownloads: body.allowDownloads,
  });
  return json({ publicShare: sharePayload(folder, token, env) });
}

async function getPublicFolder(env: Env, token: string): Promise<Response> {
  const folder = await resolvePublicFolder(env, token);
  const memberships = await loadFolderClipRows(env, [folder.id]);
  return json({ folder: await presentPublicFolder(env, folder, memberships) });
}

async function publicFolderPlayback(env: Env, token: string, clipId: string): Promise<Response> {
  const playbackUrl = await signPublicFolderMedia(env, token, clipId, PUBLIC_PLAYBACK_TTL);
  return json({ playbackUrl });
}

async function publicFolderDownload(env: Env, token: string, clipId: string): Promise<Response> {
  const folder = await resolvePublicFolder(env, token);
  if (!folder.allow_public_downloads) {
    throw new HttpError(403, "Downloads are disabled for this folder.");
  }
  const downloadUrl = await signPublicFolderMedia(env, token, clipId, PUBLIC_DOWNLOAD_TTL, folder);
  recordFolderPublicDownloadEvent(env, { folderId: folder.id, clipId, ownerId: folder.owner_id });
  return json({ downloadUrl });
}

async function signPublicFolderMedia(
  env: Env,
  token: string,
  clipId: string,
  expires: number,
  resolved?: FolderRow,
): Promise<string> {
  if (!FOLDER_UUID.test(clipId)) throw new HttpError(404, "That clip was not found in this folder.");
  const folder = resolved ?? (await resolvePublicFolder(env, token));
  const memberships = await serviceRest<Array<{ clip_id: string }>>(
    env,
    "GET",
    `/folder_clips?folder_id=eq.${folder.id}&clip_id=eq.${clipId}&select=clip_id`,
  );
  if (!memberships[0]) throw new HttpError(404, "That clip was not found in this folder.");
  const clips = await serviceRest<MediaClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&status=eq.ready&select=${CLIP_MEDIA_SELECT}`,
  );
  const clip = clips[0];
  requireR2(env);
  const url = clip ? await signedOwnedUrl(env, clip.user_id, clip.storage_key, "GET", undefined, expires) : null;
  if (!url) throw new HttpError(404, "That clip was not found in this folder.");
  return url;
}

export async function resolvePublicFolder(env: Env, token: string): Promise<FolderRow> {
  if (!PUBLIC_FOLDER_TOKEN.test(token)) throw new HttpError(404, NOT_FOUND);
  const hash = await hashPublicFolderToken(token);
  const folders = await serviceRest<FolderRow[]>(
    env,
    "GET",
    `/folders?public_token_hash=eq.${hash}&public_enabled=eq.true&select=${FOLDER_SELECT}`,
  );
  const folder = folders[0];
  if (!folder || !folder.public_enabled || !folder.public_token_hash) {
    throw new HttpError(404, NOT_FOUND);
  }
  return folder;
}

async function persistPublicLink(
  env: Env,
  current: FolderRow,
  token: string | null,
  options: { enabled: boolean; rotate: boolean },
): Promise<FolderRow> {
  const now = new Date().toISOString();
  const hash = token ? await hashPublicFolderToken(token) : null;
  const patch: Record<string, unknown> = {
    public_enabled: options.enabled,
    visibility: options.enabled ? "public_link" : "private",
    public_token_hash: hash,
    public_enabled_at: options.enabled ? current.public_enabled_at ?? now : null,
    public_token_version: options.rotate ? current.public_token_version + 1 : current.public_token_version,
  };
  const rows = await serviceRest<FolderRow[]>(
    env,
    "PATCH",
    `/folders?id=eq.${current.id}`,
    patch,
    "return=representation",
  );
  const folder = rows[0];
  if (!folder) throw new HttpError(502, "Could not update that public link.");
  if (token) {
    await serviceRest(
      env,
      "POST",
      "/folder_public_secrets?on_conflict=folder_id",
      { folder_id: current.id, token, updated_at: now },
      "resolution=merge-duplicates,return=minimal",
    );
  } else {
    await serviceRest(env, "DELETE", `/folder_public_secrets?folder_id=eq.${current.id}`);
  }
  return folder;
}

async function loadSecretToken(env: Env, folderId: string): Promise<string | null> {
  const rows = await serviceRest<SecretRow[]>(
    env,
    "GET",
    `/folder_public_secrets?folder_id=eq.${folderId}&select=folder_id,token`,
  );
  return rows[0]?.token ?? null;
}

function sharePayload(folder: FolderRow, token: string | null, env: Env) {
  return {
    enabled: Boolean(folder.public_enabled),
    url: folder.public_enabled && token ? publicFolderUrl(originFromEnv(env), token) : null,
    allowDownloads: Boolean(folder.allow_public_downloads),
  };
}

async function presentPublicFolder(env: Env, folder: FolderRow, memberships: FolderClipRow[]): Promise<PublicFolder> {
  const mine = memberships.filter((row) => row.folder_id === folder.id);
  const clipIds = mine.map((row) => row.clip_id);
  const clips = clipIds.length
    ? await serviceRest<MediaClipRow[]>(
        env,
        "GET",
        `/clips?id=in.(${clipIds.join(",")})&status=eq.ready&select=${CLIP_MEDIA_SELECT}`,
      )
    : [];
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const people = await loadProfileCards(env, [folder.owner_id]);
  const ownerUser = people.get(folder.owner_id);
  const owner: PublicFolderOwner | null = ownerUser
    ? { username: ownerUser.username, displayName: ownerUser.displayName, avatarUrl: ownerUser.avatarUrl }
    : null;
  requireR2(env);
  const presented: PublicFolderClip[] = [];
  for (const membership of mine) {
    const clip = byId.get(membership.clip_id);
    if (!clip) continue;
    presented.push({
      id: clip.id,
      title: clip.title,
      durationMs: clip.duration_ms,
      createdAt: clip.created_at,
      thumbnailUrl: await signedOwnedUrl(env, clip.user_id, clip.thumbnail_key, "GET", undefined, PUBLIC_PLAYBACK_TTL),
    });
  }
  const coverId = folder.cover_clip_id && presented.some((clip) => clip.id === folder.cover_clip_id)
    ? folder.cover_clip_id
    : presented[0]?.id;
  return {
    id: folder.id,
    name: folder.name,
    description: folder.description,
    owner,
    clipCount: presented.length,
    allowDownloads: Boolean(folder.allow_public_downloads),
    coverThumbnailUrl: presented.find((clip) => clip.id === coverId)?.thumbnailUrl ?? presented[0]?.thumbnailUrl ?? null,
    clips: presented,
  };
}
