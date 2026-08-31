import type { Env } from "./env";
import { loadFollowState } from "./follows";
import { HttpError, json } from "./http";
import {
  allowedInviteRoles,
  allowedRoleChanges,
  canInviteRole,
  canRemoveMember,
  canChangeMemberRole,
  FOLDER_SELECT,
  FOLDER_UUID,
  loadFolderClipRows,
  loadProfileCards,
  mapFolderTransferError,
  OWNER_LEAVE_MESSAGE,
  parseMemberRole,
  presentFolderDetail,
  presentFolders,
  requireFolderPermission,
  type FolderRow,
} from "./folders";
import { requireR2, requireUser, serviceRest, signedOwnedUrl } from "./shared";
import { insertNotifications, toSocialUser, USERNAME, type ProfileRow } from "./social";
import type {
  FolderInvite,
  FolderMember,
  FolderMemberRole,
  FolderRole,
  SocialUser,
} from "./social-types";

type InviteRow = {
  id: string;
  folder_id: string;
  inviter_id: string;
  invitee_id: string;
  role: FolderMemberRole;
  status: "pending" | "accepted" | "declined";
  created_at: string;
};

type MemberRow = {
  folder_id: string;
  user_id: string;
  role: FolderMemberRole;
  invited_by: string | null;
  created_at: string;
};

type PlaybackClipRow = {
  id: string;
  user_id: string;
  title: string | null;
  slug: string;
  status: string;
  storage_key: string | null;
};

const INVITE_SELECT = "id,folder_id,inviter_id,invitee_id,role,status,created_at";
const MEMBER_SELECT = "folder_id,user_id,role,invited_by,created_at";

/**
 * Blocks only apply to NEW invitations. An existing folder_members row is
 * left in place if either user later blocks the other. Collaboration and
 * social blocking stay separate in Phase 2.
 */
export async function handleFolderCollab(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/v1/folders/shared" && request.method === "GET") {
    return listSharedFolders(request, env);
  }
  if (url.pathname === "/v1/folders/invites" && request.method === "GET") {
    return listIncomingInvites(request, env);
  }

  const playback = url.pathname.match(/^\/v1\/folders\/([^/]+)\/clips\/([^/]+)\/playback$/);
  if (playback?.[1] && playback[2] && request.method === "GET") {
    return playFolderClip(request, env, playback[1], playback[2]);
  }

  const accept = url.pathname.match(/^\/v1\/folders\/([^/]+)\/invites\/([^/]+)\/accept$/);
  if (accept?.[1] && accept[2] && request.method === "POST") {
    return acceptFolderInvite(request, env, accept[1], accept[2]);
  }

  const inviteOne = url.pathname.match(/^\/v1\/folders\/([^/]+)\/invites\/([^/]+)$/);
  if (inviteOne?.[1] && inviteOne[2] && request.method === "DELETE") {
    return declineOrRevokeInvite(request, env, inviteOne[1], inviteOne[2]);
  }

  const invites = url.pathname.match(/^\/v1\/folders\/([^/]+)\/invites$/);
  if (invites?.[1] && request.method === "POST") return createFolderInvite(request, env, invites[1]);
  if (invites?.[1] && request.method === "GET") return listFolderInvites(request, env, invites[1]);

  if (url.pathname.match(/^\/v1\/folders\/([^/]+)\/members\/me$/) && request.method === "DELETE") {
    const folderId = url.pathname.split("/")[3];
    if (folderId) return leaveFolder(request, env, folderId);
  }

  const memberOne = url.pathname.match(/^\/v1\/folders\/([^/]+)\/members\/([^/]+)$/);
  if (memberOne?.[1] && memberOne[2] && request.method === "PATCH") {
    return changeMemberRole(request, env, memberOne[1], memberOne[2]);
  }
  if (memberOne?.[1] && memberOne[2] && request.method === "DELETE") {
    if (memberOne[2] === "me") return leaveFolder(request, env, memberOne[1]);
    return removeMember(request, env, memberOne[1], memberOne[2]);
  }

  const members = url.pathname.match(/^\/v1\/folders\/([^/]+)\/members$/);
  if (members?.[1] && request.method === "GET") return listFolderMembers(request, env, members[1]);

  const transfer = url.pathname.match(/^\/v1\/folders\/([^/]+)\/transfer-ownership$/);
  if (transfer?.[1] && request.method === "POST") {
    return transferFolderOwnership(request, env, transfer[1]);
  }

  return null;
}

async function listSharedFolders(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const memberships = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?user_id=eq.${user.id}&select=${MEMBER_SELECT}&order=created_at.desc`,
  );
  if (memberships.length === 0) return json({ folders: [] });
  const roles = new Map<string, FolderRole>(memberships.map((row) => [row.folder_id, row.role]));
  const folders = await serviceRest<FolderRow[]>(
    env,
    "GET",
    `/folders?id=in.(${memberships.map((row) => row.folder_id).join(",")})&select=${FOLDER_SELECT}`,
  );
  const ordered = memberships
    .map((row) => folders.find((folder) => folder.id === row.folder_id))
    .filter((folder): folder is FolderRow => Boolean(folder));
  return json({ folders: await presentFolders(env, ordered, roles) });
}

async function listIncomingInvites(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await serviceRest<InviteRow[]>(
    env,
    "GET",
    `/folder_invites?invitee_id=eq.${user.id}&status=eq.pending&select=${INVITE_SELECT}&order=created_at.desc`,
  );
  if (rows.length === 0) return json({ invites: [] });
  const folders = await serviceRest<Array<Pick<FolderRow, "id" | "name">>>(
    env,
    "GET",
    `/folders?id=in.(${[...new Set(rows.map((row) => row.folder_id))].join(",")})&select=id,name`,
  );
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const invites = await presentInvites(env, rows, { names, actor: "invitee" });
  return json({ invites });
}

async function listFolderMembers(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "view");
  const rows = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&select=${MEMBER_SELECT}&order=created_at.asc`,
  );
  const people = await loadProfileCards(env, [
    access.folder.owner_id,
    ...rows.flatMap((row) => [row.user_id, row.invited_by].filter((id): id is string => Boolean(id))),
  ]);
  const owner = people.get(access.folder.owner_id);
  if (!owner) throw new HttpError(502, "Could not load that folder owner.");
  return json({
    owner,
    members: rows.map((row) => presentMember(row, people, access.role)),
    inviteRoles: allowedInviteRoles(access.role),
    permissions: access.permissions,
  });
}

async function listFolderInvites(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "manageMembers");
  const rows = await serviceRest<InviteRow[]>(
    env,
    "GET",
    `/folder_invites?folder_id=eq.${folderId}&status=eq.pending&select=${INVITE_SELECT}&order=created_at.desc`,
  );
  return json({
    invites: await presentInvites(env, rows, { actor: access.role, folderName: access.folder.name }),
  });
}

async function createFolderInvite(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "manageMembers");
  const body = (await request.json().catch(() => ({}))) as { username?: unknown; userId?: unknown; role?: unknown };
  const role = parseMemberRole(body.role);
  if (!canInviteRole(access.role, role)) {
    throw new HttpError(403, "You cannot invite someone with that role.");
  }
  const invitee = await resolveInvitee(env, body);
  if (invitee.id === user.id) throw new HttpError(400, "You cannot invite yourself.");
  if (invitee.id === access.folder.owner_id) throw new HttpError(400, "That person already owns this folder.");

  const follow = await loadFollowState(env, user.id, invitee.id);
  if (follow.blocked) {
    throw new HttpError(403, "You cannot invite someone you have blocked, or who has blocked you.");
  }

  const existingMember = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${invitee.id}&select=${MEMBER_SELECT}`,
  );
  if (existingMember[0]) {
    return json({
      invite: null,
      alreadyMember: true,
      role: existingMember[0].role,
    });
  }

  const pending = await serviceRest<InviteRow[]>(
    env,
    "GET",
    `/folder_invites?folder_id=eq.${folderId}&invitee_id=eq.${invitee.id}&status=eq.pending&select=${INVITE_SELECT}`,
  );
  if (pending[0]) {
    return json({
      invite: (await presentInvites(env, pending, { actor: access.role, folderName: access.folder.name }))[0] ?? null,
      alreadyMember: false,
    });
  }

  let created: InviteRow | undefined;
  try {
    const rows = await serviceRest<InviteRow[]>(
      env,
      "POST",
      "/folder_invites",
      {
        folder_id: folderId,
        inviter_id: user.id,
        invitee_id: invitee.id,
        role,
        status: "pending",
      },
      "return=representation",
    );
    created = rows[0];
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
    const again = await serviceRest<InviteRow[]>(
      env,
      "GET",
      `/folder_invites?folder_id=eq.${folderId}&invitee_id=eq.${invitee.id}&status=eq.pending&select=${INVITE_SELECT}`,
    );
    created = again[0];
  }
  if (!created) throw new HttpError(502, "Could not send that invite.");

  await insertNotifications(env, [
    {
      user_id: invitee.id,
      kind: "folder_invite",
      actor_id: user.id,
      folder_id: folderId,
    },
  ]);

  return json(
    {
      invite: (await presentInvites(env, [created], { actor: access.role, folderName: access.folder.name }))[0] ?? null,
      alreadyMember: false,
    },
    201,
  );
}

async function acceptFolderInvite(request: Request, env: Env, folderId: string, inviteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const invite = await loadInvite(env, folderId, inviteId);
  if (invite.invitee_id !== user.id) throw new HttpError(403, "That invite is not for you.");
  if (invite.status === "declined") throw new HttpError(404, "That invite is no longer available.");

  const folders = await serviceRest<FolderRow[]>(env, "GET", `/folders?id=eq.${folderId}&select=${FOLDER_SELECT}`);
  const folder = folders[0];
  if (!folder) throw new HttpError(404, "That folder was not found.");
  if (folder.owner_id === user.id) {
    await markInvite(env, invite.id, "accepted");
    const memberships = await loadFolderClipRows(env, [folderId]);
    return json({ folder: await presentFolderDetail(env, folder, "owner", memberships) });
  }

  const existing = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${user.id}&select=${MEMBER_SELECT}`,
  );
  if (!existing[0]) {
    try {
      await serviceRest(
        env,
        "POST",
        "/folder_members",
        {
          folder_id: folderId,
          user_id: user.id,
          role: invite.role,
          invited_by: invite.inviter_id,
        },
        "return=minimal",
      );
    } catch (caught) {
      if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
    }
  }

  if (invite.status === "pending") {
    await markInvite(env, invite.id, "accepted");
    await insertNotifications(env, [
      {
        user_id: invite.inviter_id,
        kind: "folder_invite_accepted",
        actor_id: user.id,
        folder_id: folderId,
      },
    ]);
  }

  const memberships = await loadFolderClipRows(env, [folderId]);
  const member = existing[0] ?? { role: invite.role };
  return json({ folder: await presentFolderDetail(env, folder, member.role, memberships) });
}

async function declineOrRevokeInvite(request: Request, env: Env, folderId: string, inviteId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const invite = await loadInvite(env, folderId, inviteId);
  if (invite.status !== "pending") return json({ ok: true });

  if (invite.invitee_id === user.id) {
    await markInvite(env, invite.id, "declined");
    return json({ ok: true });
  }

  const access = await requireFolderPermission(env, folderId, user.id, "manageMembers");
  if (!canInviteRole(access.role, invite.role)) {
    throw new HttpError(403, "You cannot revoke that invite.");
  }
  await markInvite(env, invite.id, "declined");
  return json({ ok: true });
}

async function changeMemberRole(request: Request, env: Env, folderId: string, userId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!FOLDER_UUID.test(userId)) throw new HttpError(404, "That member was not found.");
  const access = await requireFolderPermission(env, folderId, user.id, "manageMembers");
  if (userId === access.folder.owner_id) throw new HttpError(403, "You cannot change the folder owner.");
  const body = (await request.json().catch(() => ({}))) as { role?: unknown };
  const next = parseMemberRole(body.role);
  const members = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${userId}&select=${MEMBER_SELECT}`,
  );
  const member = members[0];
  if (!member) throw new HttpError(404, "That member was not found.");
  if (!canChangeMemberRole(access.role, member.role, next)) {
    throw new HttpError(403, "You cannot change that member's role.");
  }
  const rows = await serviceRest<MemberRow[]>(
    env,
    "PATCH",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${userId}`,
    { role: next },
    "return=representation",
  );
  const updated = rows[0] ?? { ...member, role: next };
  const people = await loadProfileCards(env, [updated.user_id, updated.invited_by].filter((id): id is string => Boolean(id)));
  return json({ member: presentMember(updated, people, access.role) });
}

async function removeMember(request: Request, env: Env, folderId: string, userId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (userId === user.id) return leaveFolder(request, env, folderId);
  if (!FOLDER_UUID.test(userId)) throw new HttpError(404, "That member was not found.");
  const access = await requireFolderPermission(env, folderId, user.id, "manageMembers");
  if (userId === access.folder.owner_id) {
    throw new HttpError(403, "You cannot remove the folder owner.");
  }
  const members = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${userId}&select=${MEMBER_SELECT}`,
  );
  const member = members[0];
  if (!member) return json({ ok: true });
  if (!canRemoveMember(access.role, member.role)) {
    throw new HttpError(403, "You cannot remove that member.");
  }
  await serviceRest(env, "DELETE", `/folder_members?folder_id=eq.${folderId}&user_id=eq.${userId}`);
  return json({ ok: true });
}

async function leaveFolder(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const folders = await serviceRest<FolderRow[]>(env, "GET", `/folders?id=eq.${folderId}&select=${FOLDER_SELECT}`);
  const folder = folders[0];
  if (!folder) throw new HttpError(404, "That folder was not found.");
  if (folder.owner_id === user.id) {
    throw new HttpError(400, OWNER_LEAVE_MESSAGE);
  }
  await serviceRest(env, "DELETE", `/folder_members?folder_id=eq.${folderId}&user_id=eq.${user.id}`);
  return json({ ok: true });
}

async function transferFolderOwnership(request: Request, env: Env, folderId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "transferOwnership");
  const body = (await request.json().catch(() => ({}))) as { username?: unknown; userId?: unknown };
  const target = await resolveInvitee(env, body);
  if (target.id === user.id || target.id === access.folder.owner_id) {
    throw new HttpError(400, "You already own this folder.");
  }

  const members = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/folder_members?folder_id=eq.${folderId}&user_id=eq.${target.id}&select=${MEMBER_SELECT}`,
  );
  if (!members[0]) {
    throw new HttpError(400, "That person is not an active member of this folder.");
  }

  try {
    await serviceRest(env, "POST", "/rpc/transfer_folder_ownership", {
      p_folder_id: folderId,
      p_from_user_id: user.id,
      p_to_user_id: target.id,
    });
  } catch (caught) {
    if (caught instanceof HttpError) {
      const mapped = mapFolderTransferError(caught.message);
      if (mapped) throw mapped;
    }
    throw caught;
  }

  const folders = await serviceRest<FolderRow[]>(env, "GET", `/folders?id=eq.${folderId}&select=${FOLDER_SELECT}`);
  const folder = folders[0];
  if (!folder) throw new HttpError(404, "That folder was not found.");
  const memberships = await loadFolderClipRows(env, [folderId]);
  return json({ folder: await presentFolderDetail(env, folder, "manager", memberships) });
}

async function playFolderClip(request: Request, env: Env, folderId: string, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!FOLDER_UUID.test(clipId)) throw new HttpError(404, "That clip was not found in this folder.");
  await requireFolderPermission(env, folderId, user.id, "view");
  const memberships = await serviceRest<Array<{ clip_id: string }>>(
    env,
    "GET",
    `/folder_clips?folder_id=eq.${folderId}&clip_id=eq.${clipId}&select=clip_id`,
  );
  if (!memberships[0]) throw new HttpError(404, "That clip was not found in this folder.");
  const clips = await serviceRest<PlaybackClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&status=eq.ready&select=id,user_id,title,slug,status,storage_key`,
  );
  const clip = clips[0];
  requireR2(env);
  const playbackUrl = clip ? await signedOwnedUrl(env, clip.user_id, clip.storage_key, "GET") : null;
  if (!playbackUrl) throw new HttpError(404, "That clip was not found in this folder.");
  return json({ playbackUrl });
}

async function resolveInvitee(
  env: Env,
  body: { username?: unknown; userId?: unknown },
): Promise<SocialUser> {
  if (typeof body.userId === "string" && FOLDER_UUID.test(body.userId)) {
    const rows = await serviceRest<ProfileRow[]>(
      env,
      "GET",
      `/profiles?id=eq.${body.userId}&select=id,username,display_name,avatar_url,is_verified`,
    );
    if (!rows[0]) throw new HttpError(404, "That account was not found.");
    return toSocialUser(rows[0]);
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!USERNAME.test(username)) throw new HttpError(400, "Enter a Replayr username.");
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?username_normalized=eq.${username.toLowerCase()}&select=id,username,display_name,avatar_url,is_verified`,
  );
  if (!rows[0]) throw new HttpError(404, "That account was not found.");
  return toSocialUser(rows[0]);
}

async function loadInvite(env: Env, folderId: string, inviteId: string): Promise<InviteRow> {
  if (!FOLDER_UUID.test(folderId) || !FOLDER_UUID.test(inviteId)) {
    throw new HttpError(404, "That invite was not found.");
  }
  const rows = await serviceRest<InviteRow[]>(
    env,
    "GET",
    `/folder_invites?id=eq.${inviteId}&folder_id=eq.${folderId}&select=${INVITE_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That invite was not found.");
  return rows[0];
}

async function markInvite(env: Env, inviteId: string, status: "accepted" | "declined"): Promise<void> {
  await serviceRest(env, "PATCH", `/folder_invites?id=eq.${inviteId}`, { status });
}

function presentMember(row: MemberRow, people: Map<string, SocialUser>, actor: FolderRole): FolderMember {
  const user = people.get(row.user_id);
  if (!user) {
    return {
      user: { id: row.user_id, username: null, displayName: "Player", avatarUrl: null, verified: false },
      role: row.role,
      createdAt: row.created_at,
      invitedBy: row.invited_by ? people.get(row.invited_by) ?? null : null,
      canChangeRole: canChangeMemberRole(actor, row.role, row.role),
      allowedRoles: allowedRoleChanges(actor, row.role),
      canRemove: canRemoveMember(actor, row.role),
    };
  }
  return {
    user,
    role: row.role,
    createdAt: row.created_at,
    invitedBy: row.invited_by ? people.get(row.invited_by) ?? null : null,
    canChangeRole: allowedRoleChanges(actor, row.role).length > 1,
    allowedRoles: allowedRoleChanges(actor, row.role),
    canRemove: canRemoveMember(actor, row.role),
  };
}

async function presentInvites(
  env: Env,
  rows: InviteRow[],
  options: { actor: FolderRole | "invitee"; folderName?: string; names?: Map<string, string> },
): Promise<FolderInvite[]> {
  const people = await loadProfileCards(
    env,
    rows.flatMap((row) => [row.invitee_id, row.inviter_id]),
  );
  return rows.map((row) => ({
    id: row.id,
    folderId: row.folder_id,
    folderName: options.folderName ?? options.names?.get(row.folder_id),
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    invitee: people.get(row.invitee_id) ?? {
      id: row.invitee_id,
      username: null,
      displayName: "Player",
      avatarUrl: null,
      verified: false,
    },
    inviter: people.get(row.inviter_id) ?? {
      id: row.inviter_id,
      username: null,
      displayName: "Player",
      avatarUrl: null,
      verified: false,
    },
    canRevoke: options.actor === "invitee" ? false : canInviteRole(options.actor, row.role),
  }));
}
