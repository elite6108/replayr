import { observeServerAnalytics, SERVER_ANALYTICS_EVENTS } from "./analytics";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireR2, requireUser, serviceRest, signedOwnedUrl } from "./shared";
import { toSocialUser, type ProfileRow } from "./social";
import type {
  Folder,
  FolderClip,
  FolderDetail,
  FolderMemberRole,
  FolderPermissions,
  FolderPublicShare,
  FolderRole,
  SocialUser,
} from "./social-types";

export const FOLDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PUBLIC_FOLDER_TOKEN = /^[A-Za-z0-9_-]{20,43}$/;
export const FOLDER_SELECT =
  "id,owner_id,name,description,visibility,allow_downloads,allow_public_downloads,public_enabled,public_slug,public_token_hash,public_token_version,public_enabled_at,cover_clip_id,created_at,updated_at";
const PROFILE_CARD = "id,username,display_name,avatar_url,is_verified";
const CLIP_SELECT = "id,user_id,title,slug,status,visibility,duration_ms,created_at,thumbnail_key";

export type FolderRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  visibility: "private" | "public_link";
  allow_downloads: boolean;
  allow_public_downloads: boolean;
  public_enabled: boolean;
  public_slug: string | null;
  public_token_hash: string | null;
  public_token_version: number;
  public_enabled_at: string | null;
  cover_clip_id: string | null;
  created_at: string;
  updated_at: string;
};

export type FolderClipRow = {
  folder_id: string;
  clip_id: string;
  added_by: string;
  position: number | null;
  created_at: string;
};

type FolderMemberRow = {
  folder_id: string;
  user_id: string;
  role: "manager" | "editor" | "viewer";
};

type ClipRow = {
  id: string;
  user_id: string;
  title: string | null;
  slug: string;
  status: FolderClip["status"];
  visibility: FolderClip["visibility"];
  duration_ms: number | null;
  created_at: string;
  thumbnail_key: string | null;
};

export type FolderAccess = {
  folder: FolderRow;
  role: FolderRole;
  permissions: FolderPermissions;
};

export const OWNER_LEAVE_MESSAGE = "You must transfer ownership or delete the folder before leaving.";

const NO_EDITS = {
  viewEdits: false,
  createEdits: false,
  modifyEdits: false,
  deleteOwnEdits: false,
  deleteAnyEdits: false,
  renderEdits: false,
} as const;

const EDITOR_EDITS = {
  viewEdits: true,
  createEdits: true,
  modifyEdits: true,
  deleteOwnEdits: true,
  deleteAnyEdits: false,
  renderEdits: true,
} as const;

const MANAGE_EDITS = {
  ...EDITOR_EDITS,
  deleteAnyEdits: true,
} as const;

const DENIED: FolderPermissions = {
  view: false,
  download: false,
  addClips: false,
  removeClips: false,
  editClips: false,
  manageFolder: false,
  manageMembers: false,
  managePublicShare: false,
  deleteFolder: false,
  transferOwnership: false,
  ...NO_EDITS,
};

export function permissionsFromRole(role: FolderRole | null, allowDownloads: boolean): FolderPermissions {
  if (!role) return { ...DENIED };
  if (role === "owner") {
    return {
      view: true,
      download: true,
      addClips: true,
      removeClips: true,
      editClips: true,
      manageFolder: true,
      manageMembers: true,
      managePublicShare: true,
      deleteFolder: true,
      transferOwnership: true,
      ...MANAGE_EDITS,
    };
  }
  if (role === "manager") {
    return {
      view: true,
      download: true,
      addClips: true,
      removeClips: true,
      editClips: true,
      manageFolder: true,
      manageMembers: true,
      managePublicShare: true,
      deleteFolder: false,
      transferOwnership: false,
      ...MANAGE_EDITS,
    };
  }
  if (role === "editor") {
    return {
      ...DENIED,
      view: true,
      download: true,
      addClips: true,
      removeClips: true,
      editClips: true,
      ...EDITOR_EDITS,
    };
  }
  return {
    ...DENIED,
    view: true,
    download: allowDownloads,
    viewEdits: role === "viewer",
  };
}

export async function resolveFolderAccess(
  env: Env,
  folderId: string,
  userId: string | null,
  asPublic = false,
): Promise<FolderAccess | null> {
  if (!FOLDER_UUID.test(folderId)) return null;
  const folders = await serviceRest<FolderRow[]>(env, "GET", `/folders?id=eq.${folderId}&select=${FOLDER_SELECT}`);
  const folder = folders[0];
  if (!folder) return null;
  if (userId && userId === folder.owner_id) {
    return { folder, role: "owner", permissions: permissionsFromRole("owner", folder.allow_downloads) };
  }
  if (userId) {
    const members = await serviceRest<FolderMemberRow[]>(
      env,
      "GET",
      `/folder_members?folder_id=eq.${folderId}&user_id=eq.${userId}&select=folder_id,user_id,role`,
    );
    const member = members[0];
    if (member) {
      return { folder, role: member.role, permissions: permissionsFromRole(member.role, folder.allow_downloads) };
    }
  }
  if (asPublic && folder.public_enabled && folder.public_token_hash) {
    return { folder, role: "public", permissions: permissionsFromRole("public", folder.allow_public_downloads) };
  }
  return null;
}

export async function requireFolderPermission(
  env: Env,
  folderId: string,
  userId: string,
  key: keyof FolderPermissions,
): Promise<FolderAccess> {
  const access = await resolveFolderAccess(env, folderId, userId);
  if (!access || !access.permissions.view) {
    throw new HttpError(404, "That folder was not found.");
  }
  if (!access.permissions[key]) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  return access;
}

export function canInviteRole(actor: FolderRole, role: FolderMemberRole): boolean {
  if (actor === "owner") return role === "manager" || role === "editor" || role === "viewer";
  if (actor === "manager") return role === "editor" || role === "viewer";
  return false;
}

export function allowedInviteRoles(actor: FolderRole): FolderMemberRole[] {
  return (["manager", "editor", "viewer"] as const).filter((role) => canInviteRole(actor, role));
}

export function canChangeMemberRole(actor: FolderRole, current: FolderMemberRole, next: FolderMemberRole): boolean {
  if (actor === "owner") return true;
  if (actor === "manager") {
    return (current === "editor" || current === "viewer") && (next === "editor" || next === "viewer");
  }
  return false;
}

export function allowedRoleChanges(actor: FolderRole, current: FolderMemberRole): FolderMemberRole[] {
  return (["manager", "editor", "viewer"] as const).filter((role) => canChangeMemberRole(actor, current, role));
}

export function canRemoveMember(actor: FolderRole, target: FolderMemberRole): boolean {
  if (actor === "owner") return true;
  if (actor === "manager") return target === "editor" || target === "viewer";
  return false;
}

export function parseMemberRole(value: unknown): FolderMemberRole {
  if (value === "manager" || value === "editor" || value === "viewer") return value;
  throw new HttpError(400, "Choose Manager, Editor, or Viewer.");
}

export function mapFolderTransferError(message: string): HttpError | null {
  if (message.includes("FOLDER_TRANSFER_SELF")) {
    return new HttpError(400, "You already own this folder.");
  }
  if (message.includes("FOLDER_TRANSFER_NOT_FOUND")) {
    return new HttpError(404, "That folder was not found.");
  }
  if (message.includes("FOLDER_TRANSFER_FORBIDDEN")) {
    return new HttpError(403, "You do not have permission to do that.");
  }
  if (message.includes("FOLDER_TRANSFER_NOT_MEMBER")) {
    return new HttpError(400, "That person is not an active member of this folder.");
  }
  if (message.includes("FOLDER_TRANSFER_INVALID_USER")) {
    return new HttpError(404, "That account was not found.");
  }
  return null;
}

export function generatePublicFolderToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashPublicFolderToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function publicFolderUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/f/${token}`;
}

export function folderAccessLabel(folder: { visibility: Folder["visibility"]; publicEnabled?: boolean }, memberCount: number): "public" | "shared" | "private" {
  if (folder.visibility === "public_link" || folder.publicEnabled) return "public";
  if (memberCount > 0) return "shared";
  return "private";
}

export async function handleFolders(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/folders")) return null;
  const { handleFolderPublicLink } = await import("./folderPublic");
  const publicLink = await handleFolderPublicLink(request, env, url);
  if (publicLink) return publicLink;
  const { handleFolderCollab } = await import("./folderCollab");
  const collab = await handleFolderCollab(request, env, url);
  if (collab) return collab;
  const { handleFolderEdits } = await import("./folderEdits");
  const edits = await handleFolderEdits(request, env, url);
  if (edits) return edits;
  const { handleFolderActivity } = await import("./folderActivity");
  const activity = await handleFolderActivity(request, env, url);
  if (activity) return activity;
  if (url.pathname === "/v1/folders" && request.method === "GET") return listMyFolders(request, env);
  if (url.pathname === "/v1/folders" && request.method === "POST") return createFolder(request, env);
  const clipRemove = url.pathname.match(/^\/v1\/folders\/([^/]+)\/clips\/([^/]+)$/);
  if (clipRemove?.[1] && clipRemove[2] && request.method === "DELETE") {
    return removeFolderClip(request, env, clipRemove[1], clipRemove[2]);
  }
  const clips = url.pathname.match(/^\/v1\/folders\/([^/]+)\/clips$/);
  if (clips?.[1] && request.method === "POST") return addFolderClips(request, env, clips[1]);
  const one = url.pathname.match(/^\/v1\/folders\/([^/]+)$/);
  if (one?.[1] && request.method === "GET") return getFolder(request, env, one[1]);
  if (one?.[1] && request.method === "PATCH") return updateFolder(request, env, one[1]);
  if (one?.[1] && request.method === "DELETE") return deleteFolder(request, env, one[1]);
  return null;
}

async function listMyFolders(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const folders = await serviceRest<FolderRow[]>(
    env,
    "GET",
    `/folders?owner_id=eq.${user.id}&select=${FOLDER_SELECT}&order=created_at.desc`,
  );
  const presented = await presentFolders(env, folders, "owner");
  return json({ folders: presented });
}

async function createFolder(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
  const name = parseName(body.name);
  const description = parseDescription(body.description);
  const rows = await serviceRest<FolderRow[]>(
    env,
    "POST",
    "/folders",
    {
      owner_id: user.id,
      name,
      description,
      visibility: "private",
      allow_downloads: true,
      allow_public_downloads: false,
      public_enabled: false,
    },
    "return=representation",
  );
  const folder = rows[0];
  if (!folder) throw new HttpError(502, "Could not create that folder.");
  observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.folderCreated, {
    userId: user.id,
    entityId: folder.id,
  });
  return json({ folder: await presentFolderDetail(env, folder, "owner", []) }, 201);
}

async function getFolder(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "view");
  const memberships = await loadFolderClipRows(env, [folderId]);
  return json({ folder: await presentFolderDetail(env, access.folder, access.role, memberships) });
}

async function updateFolder(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "manageFolder");
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = parseName(body.name);
  if (body.description !== undefined) patch.description = parseDescription(body.description);
  if (Object.keys(patch).length === 0) {
    const memberships = await loadFolderClipRows(env, [folderId]);
    return json({ folder: await presentFolderDetail(env, access.folder, access.role, memberships) });
  }
  const rows = await serviceRest<FolderRow[]>(
    env,
    "PATCH",
    `/folders?id=eq.${folderId}`,
    patch,
    "return=representation",
  );
  const folder = rows[0] ?? access.folder;
  const memberships = await loadFolderClipRows(env, [folderId]);
  return json({ folder: await presentFolderDetail(env, folder, access.role, memberships) });
}

async function deleteFolder(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await requireFolderPermission(env, folderId, user.id, "deleteFolder");
  await serviceRest(env, "DELETE", `/folders?id=eq.${folderId}`);
  return json({ ok: true });
}

async function addFolderClips(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "addClips");
  const body = (await request.json().catch(() => ({}))) as { clipIds?: unknown };
  const clipIds = Array.isArray(body.clipIds)
    ? [...new Set(body.clipIds.filter((id): id is string => typeof id === "string" && FOLDER_UUID.test(id)))]
    : [];
  if (clipIds.length === 0) throw new HttpError(400, "Choose at least one clip.");
  const clips = await serviceRest<ClipRow[]>(
    env,
    "GET",
    `/clips?id=in.(${clipIds.join(",")})&user_id=eq.${user.id}&status=eq.ready&select=${CLIP_SELECT}`,
  );
  if (clips.length !== clipIds.length) {
    throw new HttpError(400, "Only your ready cloud clips can be added to a folder.");
  }
  try {
    await serviceRest(
      env,
      "POST",
      "/folder_clips?on_conflict=folder_id,clip_id",
      clipIds.map((clipId) => ({ folder_id: folderId, clip_id: clipId, added_by: user.id })),
      "resolution=ignore-duplicates,return=minimal",
    );
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
  }
  for (const clipId of clipIds) {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.folderClipAdded, {
      userId: user.id,
      entityId: clipId,
      idempotencyKey: `folder.clip_added:${folderId}:${clipId}`,
    });
  }
  const memberships = await loadFolderClipRows(env, [folderId]);
  const { logFolderActivity } = await import("./folderActivity");
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "clip_added",
    metadata: { clipIds },
  });
  return json({ folder: await presentFolderDetail(env, access.folder, access.role, memberships) });
}

async function removeFolderClip(request: Request, env: Env, folderId: string, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!FOLDER_UUID.test(clipId)) throw new HttpError(404, "That clip was not found in this folder.");
  await requireFolderPermission(env, folderId, user.id, "removeClips");
  await serviceRest(env, "DELETE", `/folder_clips?folder_id=eq.${folderId}&clip_id=eq.${clipId}`);
  const { logFolderActivity } = await import("./folderActivity");
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "clip_removed",
    entityId: clipId,
  });
  return json({ ok: true });
}

export async function loadFolderClipRows(env: Env, folderIds: string[]): Promise<FolderClipRow[]> {
  if (folderIds.length === 0) return [];
  return serviceRest<FolderClipRow[]>(
    env,
    "GET",
    `/folder_clips?folder_id=in.(${folderIds.join(",")})&select=folder_id,clip_id,added_by,position,created_at&order=created_at.desc`,
  );
}

export async function presentFolders(
  env: Env,
  folders: FolderRow[],
  roles: FolderRole | ReadonlyMap<string, FolderRole>,
): Promise<Folder[]> {
  const memberships = await loadFolderClipRows(
    env,
    folders.map((folder) => folder.id),
  );
  const coverIds = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const row of memberships) {
    counts.set(row.folder_id, (counts.get(row.folder_id) ?? 0) + 1);
    if (!coverIds.has(row.folder_id)) coverIds.set(row.folder_id, row.clip_id);
  }
  for (const folder of folders) {
    if (folder.cover_clip_id && !coverIds.has(folder.id)) coverIds.set(folder.id, folder.cover_clip_id);
  }
  const [thumbs, owners, previews, secrets] = await Promise.all([
    loadClipThumbs(env, [...new Set(coverIds.values())]),
    loadFolderOwners(env, folders),
    loadMembersPreview(env, folders.map((folder) => folder.id)),
    loadPublicSecrets(env, folders.map((folder) => folder.id)),
  ]);
  return folders.map((folder) => {
    const role = typeof roles === "string" ? roles : (roles.get(folder.id) ?? "viewer");
    const permissions = permissionsFromRole(role, folder.allow_downloads);
    return {
      id: folder.id,
      name: folder.name,
      description: folder.description,
      visibility: folder.public_enabled ? "public_link" : folder.visibility,
      allowDownloads: folder.allow_downloads,
      clipCount: counts.get(folder.id) ?? 0,
      coverThumbnailUrl: thumbs.get(coverIds.get(folder.id) ?? folder.cover_clip_id ?? "") ?? null,
      createdAt: folder.created_at,
      updatedAt: folder.updated_at,
      role,
      permissions,
      owner: owners.get(folder.owner_id) ?? null,
      membersPreview: previews.get(folder.id) ?? [],
      publicShare: presentPublicShare(folder, permissions, secrets.get(folder.id) ?? null, originFromEnv(env)),
    };
  });
}

export async function presentFolderDetail(
  env: Env,
  folder: FolderRow,
  role: FolderRole,
  memberships: FolderClipRow[],
): Promise<FolderDetail> {
  const mine = memberships.filter((row) => row.folder_id === folder.id);
  const [clips, owners, previews, secrets] = await Promise.all([
    loadFolderClips(env, mine, folder.id),
    loadFolderOwners(env, [folder]),
    loadMembersPreview(env, [folder.id]),
    loadPublicSecrets(env, [folder.id]),
  ]);
  const permissions = permissionsFromRole(role, folder.allow_downloads);
  return {
    id: folder.id,
    name: folder.name,
    description: folder.description,
    visibility: folder.public_enabled ? "public_link" : folder.visibility,
    allowDownloads: folder.allow_downloads,
    clipCount: clips.length,
    coverThumbnailUrl: clips[0]?.thumbnailUrl ?? null,
    createdAt: folder.created_at,
    updatedAt: folder.updated_at,
    role,
    permissions,
    owner: owners.get(folder.owner_id) ?? null,
    membersPreview: previews.get(folder.id) ?? [],
    publicShare: presentPublicShare(folder, permissions, secrets.get(folder.id) ?? null, originFromEnv(env)),
    clips,
  };
}

export async function loadFolderOwners(env: Env, folders: FolderRow[]): Promise<Map<string, SocialUser>> {
  const ids = [...new Set(folders.map((folder) => folder.owner_id))];
  return loadProfileCards(env, ids);
}

export async function loadProfileCards(env: Env, userIds: string[]): Promise<Map<string, SocialUser>> {
  const users = new Map<string, SocialUser>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return users;
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?id=in.(${unique.join(",")})&select=${PROFILE_CARD}`,
  );
  for (const row of rows) users.set(row.id, toSocialUser(row));
  return users;
}

async function loadMembersPreview(env: Env, folderIds: string[]): Promise<Map<string, SocialUser[]>> {
  const preview = new Map<string, SocialUser[]>();
  if (folderIds.length === 0) return preview;
  const rows = await serviceRest<Array<{ folder_id: string; user_id: string }>>(
    env,
    "GET",
    `/folder_members?folder_id=in.(${folderIds.join(",")})&select=folder_id,user_id&order=created_at.asc`,
  );
  const people = await loadProfileCards(
    env,
    rows.map((row) => row.user_id),
  );
  for (const row of rows) {
    const user = people.get(row.user_id);
    if (!user) continue;
    const list = preview.get(row.folder_id) ?? [];
    if (list.length < 4) {
      list.push(user);
      preview.set(row.folder_id, list);
    }
  }
  return preview;
}

async function loadRenderedClipIds(env: Env, folderId: string): Promise<Set<string>> {
  const rows = await serviceRest<Array<{ rendered_clip_id: string | null }>>(
    env,
    "GET",
    `/folder_clip_edits?folder_id=eq.${folderId}&rendered_clip_id=not.is.null&select=rendered_clip_id`,
  );
  return new Set(rows.map((row) => row.rendered_clip_id).filter((id): id is string => Boolean(id)));
}

async function loadFolderClips(env: Env, memberships: FolderClipRow[], folderId?: string): Promise<FolderClip[]> {
  if (memberships.length === 0) return [];
  const clipIds = memberships.map((row) => row.clip_id);
  const [rows, rendered] = await Promise.all([
    serviceRest<ClipRow[]>(
      env,
      "GET",
      `/clips?id=in.(${clipIds.join(",")})&status=neq.deleted&select=${CLIP_SELECT}`,
    ),
    folderId ? loadRenderedClipIds(env, folderId).catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  requireR2(env);
  const presented: FolderClip[] = [];
  for (const membership of memberships) {
    const clip = byId.get(membership.clip_id);
    if (!clip) continue;
    presented.push({
      id: clip.id,
      title: clip.title,
      slug: clip.slug,
      status: clip.status,
      visibility: clip.visibility,
      durationMs: clip.duration_ms,
      createdAt: clip.created_at,
      addedAt: membership.created_at,
      thumbnailUrl: await signedOwnedUrl(env, clip.user_id, clip.thumbnail_key, "GET"),
      ownerId: clip.user_id,
      kind: rendered.has(clip.id) ? "render" : "original",
    });
  }
  return presented;
}

async function loadClipThumbs(env: Env, clipIds: string[]): Promise<Map<string, string>> {
  const thumbs = new Map<string, string>();
  if (clipIds.length === 0) return thumbs;
  const rows = await serviceRest<ClipRow[]>(
    env,
    "GET",
    `/clips?id=in.(${clipIds.join(",")})&status=eq.ready&select=${CLIP_SELECT}`,
  );
  requireR2(env);
  for (const row of rows) {
    const url = await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET");
    if (url) thumbs.set(row.id, url);
  }
  return thumbs;
}

function presentPublicShare(
  folder: FolderRow,
  permissions: FolderPermissions,
  token: string | null,
  origin: string,
): FolderPublicShare | null {
  if (!permissions.managePublicShare) return null;
  return {
    enabled: Boolean(folder.public_enabled),
    url: folder.public_enabled && token ? publicFolderUrl(origin, token) : null,
    allowDownloads: Boolean(folder.allow_public_downloads),
  };
}

export async function loadPublicSecrets(env: Env, folderIds: string[]): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  if (folderIds.length === 0) return tokens;
  const rows = await serviceRest<Array<{ folder_id: string; token: string }>>(
    env,
    "GET",
    `/folder_public_secrets?folder_id=in.(${folderIds.join(",")})&select=folder_id,token`,
  );
  for (const row of rows) tokens.set(row.folder_id, row.token);
  return tokens;
}

export function originFromEnv(env: { PUBLIC_APP_URL?: string }): string {
  const origin = (env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  try {
    const host = new URL(origin).hostname;
    if (host === "127.0.0.1" || host === "localhost") return "https://replayr.tv";
  } catch {
    /* keep configured origin */
  }
  return origin || "https://replayr.tv";
}

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 80) throw new HttpError(400, "Folder names must be 1–80 characters.");
  return name;
}

function parseDescription(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError(400, "Description must be text.");
  const description = value.trim();
  if (description.length === 0) return null;
  if (description.length > 500) throw new HttpError(400, "Descriptions must be 500 characters or less.");
  return description;
}
