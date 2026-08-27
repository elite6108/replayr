import type { Env } from "./env";
import {
  lookupPlaybackRaw,
  optionalUser,
  presentPublicClips,
  PUBLIC_CLIP_SELECT,
  requireUser,
  serviceRest,
  serviceRestCount,
  signedOwnedUrl,
  type PublicClipRow,
} from "./shared";
import { HttpError, json } from "./http";
import type {
  ChatMessage,
  ConversationRole,
  ConversationSummary,
  ConversationType,
  Friend,
  FriendRequest,
  FriendshipStatus,
  MessageClip,
  NotificationKind,
  Relationship,
  SocialUser,
} from "./social-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const MAX_GROUP = 32;
const MESSAGE_LIMIT_MAX = 100;
const PROFILE_SELECT = "id,username,display_name,avatar_url,is_verified,bio,clip_count,created_at,is_private";
const FRIENDSHIP_SELECT = "id,user_a,user_b,requested_by,blocked_by,status,created_at,updated_at";
const CONVERSATION_SELECT = "id,type,title,created_by,dm_user_a,dm_user_b,created_at,updated_at";
const MESSAGE_SELECT = "id,conversation_id,sender_id,body,clip_id,created_at";
const CLIP_CARD_SELECT =
  "id,user_id,slug,title,duration_ms,visibility,thumbnail_key,games(name,slug)";

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean;
  bio?: string | null;
  clip_count?: number;
  created_at?: string;
  is_private?: boolean;
};

type FriendshipRow = {
  id: string;
  user_a: string;
  user_b: string;
  requested_by: string;
  blocked_by: string | null;
  status: FriendshipStatus;
  created_at: string;
  updated_at: string;
};

type ConversationRow = {
  id: string;
  type: ConversationType;
  title: string | null;
  created_by: string;
  dm_user_a: string | null;
  dm_user_b: string | null;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  conversation_id: string;
  user_id: string;
  role: ConversationRole;
  last_read_at: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  clip_id: string | null;
  created_at: string;
};

type ClipCardRow = {
  id: string;
  user_id: string;
  slug: string;
  title: string | null;
  duration_ms: number | null;
  visibility: string;
  thumbnail_key: string | null;
  games: { name: string; slug: string } | { name: string; slug: string }[] | null;
};

type NotificationRow = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string | null;
  friendship_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  read_at: string | null;
  created_at: string;
};

export async function handleSocial(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/v1/friends" && method === "GET") return listFriends(request, env);
  if (path === "/v1/friends/requests" && method === "GET") return listFriendRequests(request, env);
  if (path === "/v1/friends/requests" && method === "POST") return createFriendRequest(request, env);

  const accept = path.match(/^\/v1\/friends\/requests\/([^/]+)\/accept$/);
  if (accept?.[1] && method === "POST") return acceptFriendRequest(request, env, accept[1]);
  const decline = path.match(/^\/v1\/friends\/requests\/([^/]+)\/decline$/);
  if (decline?.[1] && method === "POST") return declineFriendRequest(request, env, decline[1]);
  const cancel = path.match(/^\/v1\/friends\/requests\/([^/]+)$/);
  if (cancel?.[1] && method === "DELETE") return cancelFriendRequest(request, env, cancel[1]);

  const block = path.match(/^\/v1\/friends\/([^/]+)\/block$/);
  if (block?.[1] && method === "POST") return blockUser(request, env, block[1]);
  const unfriend = path.match(/^\/v1\/friends\/([^/]+)$/);
  if (unfriend?.[1] && method === "DELETE") return unfriendUser(request, env, unfriend[1]);

  if (path === "/v1/users/search" && method === "GET") return searchUsers(request, env, url);
  if (path === "/v1/users/suggestions" && method === "GET") return listUserSuggestions(request, env, url);
  const profile = path.match(/^\/v1\/users\/([^/]+)$/);
  if (profile?.[1] && method === "GET") return getUserProfile(request, env, profile[1]);

  if (path === "/v1/conversations" && method === "GET") return listConversations(request, env);
  if (path === "/v1/conversations" && method === "POST") return createConversation(request, env);

  const convMessages = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
  if (convMessages?.[1] && method === "GET") return listMessages(request, env, url, convMessages[1]);
  if (convMessages?.[1] && method === "POST") return postMessage(request, env, convMessages[1]);

  const convMembers = path.match(/^\/v1\/conversations\/([^/]+)\/members$/);
  if (convMembers?.[1] && method === "POST") return addMembers(request, env, convMembers[1]);
  if (convMembers?.[1] && method === "DELETE") return leaveConversation(request, env, convMembers[1]);

  const convItem = path.match(/^\/v1\/conversations\/([^/]+)$/);
  if (convItem?.[1] && method === "GET") {
    const conversation = await loadVisibleConversation(request, env, convItem[1]);
    return json({ conversation });
  }

  if (path === "/v1/clips/friends" && method === "GET") return listFriendClips(request, env, url);

  const send = path.match(/^\/v1\/clips\/([^/]+)\/send$/);
  if (send?.[1] && method === "POST") return sendClip(request, env, send[1]);

  if (path === "/v1/notifications" && method === "GET") return listNotifications(request, env, url);
  if (path === "/v1/notifications/read" && method === "POST") return readNotifications(request, env);

  return null;
}

export async function hasConversationClipGrant(env: Env, clipId: string, userId: string): Promise<boolean> {
  const grants = await serviceRest<{ conversation_id: string }[]>(
    env,
    "GET",
    `/conversation_clips?clip_id=eq.${clipId}&select=conversation_id`,
  );
  if (grants.length === 0) return false;
  const members = await serviceRest<{ conversation_id: string }[]>(
    env,
    "GET",
    `/conversation_members?user_id=eq.${userId}&conversation_id=in.(${grants.map((row) => row.conversation_id).join(",")})&select=conversation_id&limit=1`,
  );
  return members.length > 0;
}

async function listFriends(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?or=(user_a.eq.${user.id},user_b.eq.${user.id})&status=eq.accepted&select=${FRIENDSHIP_SELECT}&order=updated_at.desc`,
  );
  const otherIds = rows.map((row) => otherUser(row, user.id));
  const people = await loadSocialUsers(env, otherIds);
  const dms = await dmIdsForUser(env, user.id);
  const friends: Friend[] = [];
  for (const row of rows) {
    const other = people.get(otherUser(row, user.id));
    if (!other) continue;
    friends.push({
      ...other,
      friendshipId: row.id,
      since: row.updated_at,
      dmId: dms.get(other.id) ?? null,
    });
  }
  return json({ friends });
}

async function listFriendRequests(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?or=(user_a.eq.${user.id},user_b.eq.${user.id})&status=eq.pending&select=${FRIENDSHIP_SELECT}&order=created_at.desc`,
  );
  const people = await loadSocialUsers(
    env,
    rows.flatMap((row) => [row.user_a, row.user_b]),
  );
  const incoming: FriendRequest[] = [];
  const outgoing: FriendRequest[] = [];
  for (const row of rows) {
    const from = people.get(row.requested_by);
    const toId = otherUser(row, row.requested_by);
    const to = people.get(toId);
    if (!from || !to) continue;
    const item = { id: row.id, createdAt: row.created_at, from, to };
    if (row.requested_by === user.id) outgoing.push(item);
    else incoming.push(item);
  }
  return json({ incoming, outgoing });
}

async function createFriendRequest(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const target = await resolveTargetUser(env, body);
  if (target.id === user.id) {
    throw new HttpError(400, "You cannot friend yourself.");
  }
  const existing = await loadFriendship(env, user.id, target.id);
  if (existing?.status === "accepted") {
    throw new HttpError(409, "You are already friends.");
  }
  if (existing?.status === "blocked") {
    throw new HttpError(403, "You cannot send a friend request to that account.");
  }
  if (existing?.status === "pending") {
    if (existing.requested_by === user.id) {
      const people = await loadSocialUsers(env, [user.id, target.id]);
      const from = people.get(user.id);
      const to = people.get(target.id);
      if (!from || !to) throw new HttpError(404, "That account was not found.");
      return json({ request: { id: existing.id, createdAt: existing.created_at, from, to } });
    }
    throw new HttpError(409, "They already sent you a friend request.");
  }
  const pair = ordered(user.id, target.id);
  const id = crypto.randomUUID();
  await serviceRest(env, "POST", "/friendships", {
    id,
    user_a: pair.user_a,
    user_b: pair.user_b,
    requested_by: user.id,
    status: "pending",
  });
  await insertNotifications(env, [
    {
      user_id: target.id,
      kind: "friend_request",
      actor_id: user.id,
      friendship_id: id,
    },
  ]);
  const me = (await loadSocialUsers(env, [user.id])).get(user.id);
  if (!me) throw new HttpError(500, "Could not load your profile.");
  return json({
    request: {
      id,
      createdAt: new Date().toISOString(),
      from: me,
      to: toSocialUser(target),
    },
  });
}

async function acceptFriendRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const row = await requireFriendship(env, requestId);
  if (row.status !== "pending") throw new HttpError(404, "That friend request was not found.");
  if (row.requested_by === user.id || !involves(row, user.id)) {
    throw new HttpError(403, "You can only accept a request sent to you.");
  }
  await serviceRest(env, "PATCH", `/friendships?id=eq.${row.id}`, { status: "accepted", blocked_by: null });
  await insertNotifications(env, [
    {
      user_id: row.requested_by,
      kind: "friend_accept",
      actor_id: user.id,
      friendship_id: row.id,
    },
  ]);
  const otherId = otherUser(row, user.id);
  const people = await loadSocialUsers(env, [otherId]);
  const friend = people.get(otherId);
  if (!friend) throw new HttpError(404, "That account was not found.");
  const dms = await dmIdsForUser(env, user.id);
  return json({
    ok: true,
    friend: {
      ...friend,
      friendshipId: row.id,
      since: new Date().toISOString(),
      dmId: dms.get(otherId) ?? null,
    },
  });
}

async function declineFriendRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const row = await requireFriendship(env, requestId);
  if (row.status !== "pending") throw new HttpError(404, "That friend request was not found.");
  if (row.requested_by === user.id || !involves(row, user.id)) {
    throw new HttpError(403, "You can only decline a request sent to you.");
  }
  await serviceRest(env, "DELETE", `/friendships?id=eq.${row.id}`);
  return json({ ok: true });
}

async function cancelFriendRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const row = await requireFriendship(env, requestId);
  if (row.status !== "pending" || row.requested_by !== user.id) {
    throw new HttpError(403, "You can only cancel a request you sent.");
  }
  await serviceRest(env, "DELETE", `/friendships?id=eq.${row.id}`);
  return json({ ok: true });
}

async function unfriendUser(request: Request, env: Env, userId: string): Promise<Response> {
  const user = await requireUser(request, env);
  requireUuid(userId);
  if (userId === user.id) throw new HttpError(400, "You cannot unfriend yourself.");
  const row = await loadFriendship(env, user.id, userId);
  if (!row) throw new HttpError(404, "You are not friends with that account.");
  if (row.status === "blocked") {
    if (row.blocked_by !== user.id) {
      throw new HttpError(403, "You cannot unfriend that account.");
    }
    await serviceRest(env, "DELETE", `/friendships?id=eq.${row.id}`);
    return json({ ok: true });
  }
  if (row.status !== "accepted") throw new HttpError(404, "You are not friends with that account.");
  await serviceRest(env, "DELETE", `/friendships?id=eq.${row.id}`);
  return json({ ok: true });
}

async function blockUser(request: Request, env: Env, userId: string): Promise<Response> {
  const user = await requireUser(request, env);
  requireUuid(userId);
  if (userId === user.id) throw new HttpError(400, "You cannot block yourself.");
  const target = await loadProfile(env, userId);
  if (!target) throw new HttpError(404, "That account was not found.");
  const pair = ordered(user.id, userId);
  const existing = await loadFriendship(env, user.id, userId);
  if (existing) {
    await serviceRest(env, "PATCH", `/friendships?id=eq.${existing.id}`, {
      status: "blocked",
      blocked_by: user.id,
    });
  } else {
    await serviceRest(env, "POST", "/friendships", {
      id: crypto.randomUUID(),
      user_a: pair.user_a,
      user_b: pair.user_b,
      requested_by: user.id,
      blocked_by: user.id,
      status: "blocked",
    });
  }
  return json({ ok: true });
}

async function searchUsers(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const raw = (url.searchParams.get("q") || "").trim().toLowerCase();
  const q = raw.replace(/[^a-z0-9_]/g, "").slice(0, 24);
  if (q.length < 2) {
    return json({ users: [] });
  }
  const like = q.replace(/_/g, "\\_");
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?username_normalized=like.*${encodeURIComponent(like)}*&username=not.is.null&select=${PROFILE_SELECT}&limit=20`,
  );
  const index = await friendshipIndex(env, user.id);
  const users = [];
  for (const row of rows) {
    if (row.id === user.id) continue;
    const rel = relationshipOf(index.get(row.id) ?? null, user.id);
    if (rel === "blocked") continue;
    users.push({ ...toSocialUser(row), relationship: rel });
  }
  return json({ users });
}

async function listUserSuggestions(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(24, Math.floor(rawLimit)) : 12;
  const ownClips = await serviceRest<{ game_id: string | null }[]>(
    env,
    "GET",
    `/clips?user_id=eq.${user.id}&game_id=not.is.null&select=game_id&limit=80`,
  );
  const gameIds = [...new Set(ownClips.map((row) => row.game_id).filter((id): id is string => Boolean(id)))];
  if (gameIds.length === 0) return json({ users: [] });

  const overlap = new Map<string, number>();
  for (const group of chunkIds(gameIds)) {
    const rows = await serviceRest<{ user_id: string; game_id: string }[]>(
      env,
      "GET",
      `/clips?game_id=in.(${group.join(",")})&user_id=neq.${user.id}&status=eq.ready&visibility=eq.public&select=user_id,game_id&limit=400`,
    );
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.game_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overlap.set(row.user_id, (overlap.get(row.user_id) ?? 0) + 1);
    }
  }

  const ranked = [...overlap.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return json({ users: [] });
  const index = await friendshipIndex(env, user.id);
  const candidateIds = ranked.map(([id]) => id).filter((id) => relationshipOf(index.get(id) ?? null, user.id) === "none");
  const people = await loadSocialUsers(env, candidateIds.slice(0, Math.max(limit * 3, 24)));
  const users = [];
  for (const id of candidateIds) {
    const person = people.get(id);
    if (!person?.username) continue;
    users.push({ ...person, relationship: "none" as const });
    if (users.length >= limit) break;
  }
  return json({ users });
}

async function listFriendClips(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(48, Math.floor(rawLimit)) : 24;
  const friendships = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?or=(user_a.eq.${user.id},user_b.eq.${user.id})&status=eq.accepted&select=${FRIENDSHIP_SELECT}`,
  );
  const friendIds = friendships.map((row) => otherUser(row, user.id));
  if (friendIds.length === 0) return json({ clips: [] });
  const friendSet = new Set(friendIds);

  const byId = new Map<string, PublicClipRow>();
  for (const group of chunkIds(friendIds)) {
    const rows = await serviceRest<PublicClipRow[]>(
      env,
      "GET",
      `/clips?user_id=in.(${group.join(",")})&status=eq.ready&visibility=eq.public&${PUBLIC_CLIP_SELECT}&order=created_at.desc&limit=${limit}`,
    );
    for (const row of rows) byId.set(row.id, row);
  }

  const memberships = await serviceRest<{ conversation_id: string }[]>(
    env,
    "GET",
    `/conversation_members?user_id=eq.${user.id}&select=conversation_id`,
  );
  const conversationIds = memberships.map((row) => row.conversation_id);
  const grantClipIds: string[] = [];
  for (const group of chunkIds(conversationIds)) {
    const grants = await serviceRest<{ clip_id: string }[]>(
      env,
      "GET",
      `/conversation_clips?conversation_id=in.(${group.join(",")})&select=clip_id`,
    );
    for (const grant of grants) {
      if (!byId.has(grant.clip_id)) grantClipIds.push(grant.clip_id);
    }
  }
  for (const group of chunkIds(grantClipIds)) {
    const rows = await serviceRest<PublicClipRow[]>(
      env,
      "GET",
      `/clips?id=in.(${group.join(",")})&status=eq.ready&${PUBLIC_CLIP_SELECT}`,
    );
    for (const row of rows) {
      if (row.visibility === "private") continue;
      if (row.user_id === user.id || !friendSet.has(row.user_id)) continue;
      byId.set(row.id, row);
    }
  }

  const rows = [...byId.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
  return json({ clips: await presentPublicClips(request, env, rows) });
}

async function getUserProfile(request: Request, env: Env, username: string): Promise<Response> {
  const decoded = decodeURIComponent(username);
  if (!USERNAME.test(decoded)) throw new HttpError(404, "That account was not found.");
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?username_normalized=eq.${decoded.toLowerCase()}&select=${PROFILE_SELECT}`,
  );
  const profile = rows[0];
  if (!profile) throw new HttpError(404, "That account was not found.");
  const viewer = await optionalUser(request, env);
  const rel = viewer ? relationshipOf(await loadFriendship(env, viewer.id, profile.id), viewer.id) : "none";
  if (rel === "blocked") throw new HttpError(404, "That account was not found.");
  if (profile.is_private && viewer?.id !== profile.id && rel !== "friends") {
    throw new HttpError(404, "That account was not found.");
  }
  const clipRows = await serviceRest<PublicClipRow[]>(
    env,
    "GET",
    `/clips?user_id=eq.${profile.id}&visibility=eq.public&status=eq.ready&${PUBLIC_CLIP_SELECT}&order=created_at.desc&limit=24`,
  );
  const clips = await presentPublicClips(request, env, clipRows);
  return json({
    user: {
      ...toSocialUser(profile),
      bio: profile.bio ?? null,
      clipCount: profile.clip_count ?? 0,
      createdAt: profile.created_at ?? new Date().toISOString(),
    },
    relationship: viewer?.id === profile.id ? "none" : rel,
    clips,
  });
}

async function listConversations(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const memberships = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/conversation_members?user_id=eq.${user.id}&select=conversation_id,user_id,role,last_read_at`,
  );
  if (memberships.length === 0) return json({ conversations: [] });
  const ids = memberships.map((row) => row.conversation_id);
  const conversations = await serviceRest<ConversationRow[]>(
    env,
    "GET",
    `/conversations?id=in.(${ids.join(",")})&select=${CONVERSATION_SELECT}&order=updated_at.desc`,
  );
  const allMembers = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/conversation_members?conversation_id=in.(${ids.join(",")})&select=conversation_id,user_id,role,last_read_at`,
  );
  const presented = await presentConversationsBatch(env, user.id, conversations, allMembers);
  return json({ conversations: presented });
}

async function createConversation(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const type = body.type;
  if (type === "dm") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    requireUuid(userId);
    await requireAcceptedFriend(env, user.id, userId);
    const conversation = await getOrCreateDm(env, user.id, userId);
    return json({ conversation: await presentConversationOrThrow(env, user.id, conversation) });
  }
  if (type !== "group") {
    throw new HttpError(400, "Conversation type must be dm or group.");
  }
  const memberIds = uniqueIds(body.memberIds, body.userId).filter((id) => id !== user.id);
  if (memberIds.length < 1) {
    throw new HttpError(400, "Invite at least one friend to create a group.");
  }
  if (memberIds.length + 1 > MAX_GROUP) {
    throw new HttpError(400, "Groups can have at most 32 members.");
  }
  for (const memberId of memberIds) {
    await requireAcceptedFriend(env, user.id, memberId);
  }
  const title = optionalTitle(body.title);
  const conversationId = crypto.randomUUID();
  await serviceRest(env, "POST", "/conversations", {
    id: conversationId,
    type: "group",
    title,
    created_by: user.id,
  });
  await serviceRest(env, "POST", "/conversation_members", {
    conversation_id: conversationId,
    user_id: user.id,
    role: "owner",
  });
  for (const memberId of memberIds) {
    await serviceRest(env, "POST", "/conversation_members", {
      conversation_id: conversationId,
      user_id: memberId,
      role: "member",
    });
  }
  await insertNotifications(
    env,
    memberIds.map((memberId) => ({
      user_id: memberId,
      kind: "group_invite" as const,
      actor_id: user.id,
      conversation_id: conversationId,
    })),
  );
  const conversation = await loadConversation(env, conversationId);
  return json({ conversation: await presentConversationOrThrow(env, user.id, conversation) });
}

async function addMembers(request: Request, env: Env, conversationId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const conversation = await requireMemberConversation(env, user.id, conversationId);
  if (conversation.type !== "group") {
    throw new HttpError(400, "You can only invite friends to a group.");
  }
  const body = await readJson(request);
  const memberIds = uniqueIds(body.memberIds, body.userId).filter((id) => id !== user.id);
  if (memberIds.length < 1) throw new HttpError(400, "Choose a friend to invite.");
  const members = await conversationMembers(env, conversationId);
  if (members.length + memberIds.length > MAX_GROUP) {
    throw new HttpError(400, "Groups can have at most 32 members.");
  }
  const existing = new Set(members.map((row) => row.user_id));
  for (const memberId of memberIds) {
    await requireAcceptedFriend(env, user.id, memberId);
    if (existing.has(memberId)) continue;
    await serviceRest(env, "POST", "/conversation_members", {
      conversation_id: conversationId,
      user_id: memberId,
      role: "member",
    });
    existing.add(memberId);
  }
  await insertNotifications(
    env,
    memberIds.map((memberId) => ({
      user_id: memberId,
      kind: "group_invite" as const,
      actor_id: user.id,
      conversation_id: conversationId,
    })),
  );
  const updated = await loadConversation(env, conversationId);
  return json({ conversation: await presentConversationOrThrow(env, user.id, updated) });
}

async function leaveConversation(request: Request, env: Env, conversationId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const conversation = await requireMemberConversation(env, user.id, conversationId);
  if (conversation.type === "dm") {
    throw new HttpError(400, "Leave a group, or unfriend to close this chat.");
  }
  const members = await conversationMembers(env, conversationId);
  await serviceRest(
    env,
    "DELETE",
    `/conversation_members?conversation_id=eq.${conversationId}&user_id=eq.${user.id}`,
  );
  const remaining = members.filter((row) => row.user_id !== user.id);
  if (remaining.length === 0) {
    await serviceRest(env, "DELETE", `/conversations?id=eq.${conversationId}`);
    return json({ ok: true });
  }
  const mine = members.find((row) => row.user_id === user.id);
  if (mine?.role === "owner") {
    const next = remaining.slice().sort((a, b) => a.user_id.localeCompare(b.user_id))[0];
    await serviceRest(
      env,
      "PATCH",
      `/conversation_members?conversation_id=eq.${conversationId}&user_id=eq.${next.user_id}`,
      { role: "owner" },
    );
  }
  return json({ ok: true });
}

async function listMessages(request: Request, env: Env, url: URL, conversationId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await loadVisibleConversation(request, env, conversationId);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(MESSAGE_LIMIT_MAX, Math.floor(rawLimit)) : 50;
  const before = url.searchParams.get("before");
  let filter = `/messages?conversation_id=eq.${conversationId}&select=${MESSAGE_SELECT}&order=created_at.desc,id.desc&limit=${limit}`;
  if (before) {
    const cursor = await messageCursor(env, conversationId, before);
    filter += `&created_at=lt.${encodeURIComponent(cursor)}`;
  }
  const rows = await serviceRest<MessageRow[]>(env, "GET", filter);
  await serviceRest(
    env,
    "PATCH",
    `/conversation_members?conversation_id=eq.${conversationId}&user_id=eq.${user.id}`,
    { last_read_at: new Date().toISOString() },
  );
  const messages = await presentMessages(env, rows.slice().reverse());
  return json({ messages });
}

async function postMessage(request: Request, env: Env, conversationId: string): Promise<Response> {
  const user = await requireUser(request, env);
  await loadVisibleConversation(request, env, conversationId);
  const body = await readJson(request);
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const clipId = typeof body.clipId === "string" ? body.clipId : "";
  if (!text && !clipId) throw new HttpError(400, "Send text and/or a clip.");
  if (text.length > 2000) throw new HttpError(400, "Messages must be 2000 characters or fewer.");
  let clip: ClipCardRow | null = null;
  if (clipId) {
    requireUuid(clipId);
    clip = await loadSendableClip(env, clipId, user.id);
    await grantClip(env, conversationId, clip.id, user.id);
  }
  const messageId = crypto.randomUUID();
  await serviceRest(env, "POST", "/messages", {
    id: messageId,
    conversation_id: conversationId,
    sender_id: user.id,
    body: text || null,
    clip_id: clip?.id ?? null,
  });
  const rows = await serviceRest<MessageRow[]>(
    env,
    "GET",
    `/messages?id=eq.${messageId}&select=${MESSAGE_SELECT}`,
  );
  const message = (await presentMessages(env, rows))[0];
  if (!message) throw new HttpError(500, "Could not send that message.");
  const members = await conversationMembers(env, conversationId);
  await insertNotifications(
    env,
    members
      .filter((row) => row.user_id !== user.id)
      .map((row) => ({
        user_id: row.user_id,
        kind: "message" as const,
        actor_id: user.id,
        conversation_id: conversationId,
        message_id: messageId,
      })),
  );
  return json({ message });
}

async function sendClip(request: Request, env: Env, slug: string): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  requireUuid(conversationId);
  await loadVisibleConversation(request, env, conversationId);
  const clip = await lookupPlaybackRaw(env, slug);
  if (!clip) throw new HttpError(404, "That clip is not available.");
  const sendable = await loadSendableClip(env, clip.id, user.id);
  await grantClip(env, conversationId, sendable.id, user.id);
  const messageId = crypto.randomUUID();
  await serviceRest(env, "POST", "/messages", {
    id: messageId,
    conversation_id: conversationId,
    sender_id: user.id,
    body: null,
    clip_id: sendable.id,
  });
  const rows = await serviceRest<MessageRow[]>(
    env,
    "GET",
    `/messages?id=eq.${messageId}&select=${MESSAGE_SELECT}`,
  );
  const message = (await presentMessages(env, rows))[0];
  if (!message) throw new HttpError(500, "Could not send that clip.");
  const members = await conversationMembers(env, conversationId);
  await insertNotifications(
    env,
    members
      .filter((row) => row.user_id !== user.id)
      .map((row) => ({
        user_id: row.user_id,
        kind: "message" as const,
        actor_id: user.id,
        conversation_id: conversationId,
        message_id: messageId,
      })),
  );
  return json({ message, conversationId });
}

async function listNotifications(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(50, Math.floor(rawLimit)) : 30;
  const rows = await serviceRest<NotificationRow[]>(
    env,
    "GET",
    `/notifications?user_id=eq.${user.id}&select=id,user_id,kind,actor_id,friendship_id,conversation_id,message_id,read_at,created_at&order=created_at.desc&limit=${limit}`,
  );
  const actors = await loadSocialUsers(
    env,
    rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)),
  );
  return json({
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      readAt: row.read_at,
      actor: row.actor_id ? actors.get(row.actor_id) ?? null : null,
      friendshipId: row.friendship_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
    })),
  });
}

async function readNotifications(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && UUID.test(id))
    : [];
  const now = new Date().toISOString();
  if (ids.length > 0) {
    await serviceRest(
      env,
      "PATCH",
      `/notifications?user_id=eq.${user.id}&id=in.(${ids.join(",")})&read_at=is.null`,
      { read_at: now },
    );
  } else {
    await serviceRest(env, "PATCH", `/notifications?user_id=eq.${user.id}&read_at=is.null`, { read_at: now });
  }
  return json({ read: true });
}

async function loadVisibleConversation(request: Request, env: Env, conversationId: string): Promise<ConversationSummary> {
  const user = await requireUser(request, env);
  const conversation = await requireMemberConversation(env, user.id, conversationId);
  return presentConversationOrThrow(env, user.id, conversation);
}

async function presentConversationOrThrow(
  env: Env,
  userId: string,
  conversation: ConversationRow,
): Promise<ConversationSummary> {
  const members = await conversationMembers(env, conversation.id);
  const [summary] = await presentConversationsBatch(env, userId, [conversation], members);
  if (!summary) throw new HttpError(403, "That conversation is not available.");
  return summary;
}

async function presentConversationsBatch(
  env: Env,
  userId: string,
  conversations: ConversationRow[],
  memberships: MemberRow[],
): Promise<ConversationSummary[]> {
  if (conversations.length === 0) return [];
  const friendshipIdx = await friendshipIndex(env, userId);
  const memberIds = [...new Set(memberships.map((row) => row.user_id))];
  const people = await loadSocialUsers(env, memberIds);
  const conversationIds = conversations.map((row) => row.id);
  const lastByConversation = new Map<string, MessageRow>();
  for (const group of chunkIds(conversationIds)) {
    const lastRows = await serviceRest<MessageRow[]>(
      env,
      "GET",
      `/messages?conversation_id=in.(${group.join(",")})&select=${MESSAGE_SELECT}&order=created_at.desc&limit=200`,
    );
    for (const row of lastRows) {
      if (!lastByConversation.has(row.conversation_id)) {
        lastByConversation.set(row.conversation_id, row);
      }
    }
  }
  const lastMessages = await presentMessages(env, [...lastByConversation.values()]);
  const lastMessageById = new Map(lastMessages.map((message) => [message.id, message]));

  const out: ConversationSummary[] = [];
  for (const conversation of conversations) {
    const members = memberships.filter((row) => row.conversation_id === conversation.id);
    if (!members.some((row) => row.user_id === userId)) continue;
    if (conversation.type === "dm") {
      const otherId = conversation.dm_user_a === userId ? conversation.dm_user_b : conversation.dm_user_a;
      if (!otherId) continue;
      if (relationshipOf(friendshipIdx.get(otherId) ?? null, userId) !== "friends") continue;
    }
    const lastRow = lastByConversation.get(conversation.id) ?? null;
    const lastMessage = lastRow ? lastMessageById.get(lastRow.id) ?? null : null;
    const mine = members.find((row) => row.user_id === userId);
    let unreadCount = 0;
    if (
      lastMessage &&
      lastMessage.senderId !== userId &&
      (!mine?.last_read_at || lastMessage.createdAt > mine.last_read_at)
    ) {
      unreadCount = 1;
    }
    out.push({
      id: conversation.id,
      type: conversation.type,
      title: conversation.title,
      createdBy: conversation.created_by,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      members: members.map((row) => {
        const person = people.get(row.user_id) ?? {
          id: row.user_id,
          username: null,
          displayName: "Player",
          avatarUrl: null,
          verified: false,
        };
        return { ...person, role: row.role };
      }),
      lastMessage,
      unreadCount,
    });
  }
  return out;
}

async function presentConversation(
  env: Env,
  userId: string,
  conversation: ConversationRow,
  memberships: MemberRow[],
): Promise<ConversationSummary | null> {
  const [summary] = await presentConversationsBatch(env, userId, [conversation], memberships);
  return summary ?? null;
}

async function presentMessages(env: Env, rows: MessageRow[]): Promise<ChatMessage[]> {
  if (rows.length === 0) return [];
  const people = await loadSocialUsers(
    env,
    rows.map((row) => row.sender_id),
  );
  const clipIds = [...new Set(rows.map((row) => row.clip_id).filter((id): id is string => Boolean(id)))];
  const clips = new Map<string, MessageClip>();
  if (clipIds.length > 0) {
    const clipRows = await serviceRest<ClipCardRow[]>(
      env,
      "GET",
      `/clips?id=in.(${clipIds.join(",")})&select=${CLIP_CARD_SELECT}`,
    );
    for (const row of clipRows) {
      const game = Array.isArray(row.games) ? row.games[0] : row.games;
      clips.set(row.id, {
        id: row.id,
        slug: row.slug,
        title: row.title,
        durationMs: row.duration_ms,
        thumbnailUrl: await signedOwnedUrl(env, row.user_id, row.thumbnail_key, "GET"),
        visibility: row.visibility as MessageClip["visibility"],
        game: game ? { name: game.name, slug: game.slug } : null,
      });
    }
  }
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    sender: people.get(row.sender_id) ?? {
      id: row.sender_id,
      username: null,
      displayName: "Player",
      avatarUrl: null,
      verified: false,
    },
    clip: row.clip_id ? clips.get(row.clip_id) ?? null : null,
  }));
}

async function getOrCreateDm(env: Env, me: string, other: string): Promise<ConversationRow> {
  const pair = ordered(me, other);
  const existing = await serviceRest<ConversationRow[]>(
    env,
    "GET",
    `/conversations?type=eq.dm&dm_user_a=eq.${pair.user_a}&dm_user_b=eq.${pair.user_b}&select=${CONVERSATION_SELECT}`,
  );
  if (existing[0]) return existing[0];
  const id = crypto.randomUUID();
  try {
    await serviceRest(env, "POST", "/conversations", {
      id,
      type: "dm",
      created_by: me,
      dm_user_a: pair.user_a,
      dm_user_b: pair.user_b,
    });
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
    const raced = await serviceRest<ConversationRow[]>(
      env,
      "GET",
      `/conversations?type=eq.dm&dm_user_a=eq.${pair.user_a}&dm_user_b=eq.${pair.user_b}&select=${CONVERSATION_SELECT}`,
    );
    if (raced[0]) return raced[0];
    throw caught;
  }
  for (const [userId, role] of [
    [me, "owner"],
    [other, "member"],
  ] as const) {
    try {
      await serviceRest(env, "POST", "/conversation_members", {
        conversation_id: id,
        user_id: userId,
        role,
      });
    } catch (caught) {
      if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
    }
  }
  return loadConversation(env, id);
}

async function requireMemberConversation(env: Env, userId: string, conversationId: string): Promise<ConversationRow> {
  requireUuid(conversationId);
  const members = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/conversation_members?conversation_id=eq.${conversationId}&user_id=eq.${userId}&select=conversation_id,user_id,role,last_read_at`,
  );
  if (!members[0]) throw new HttpError(404, "That conversation was not found.");
  return loadConversation(env, conversationId);
}

async function loadConversation(env: Env, conversationId: string): Promise<ConversationRow> {
  const rows = await serviceRest<ConversationRow[]>(
    env,
    "GET",
    `/conversations?id=eq.${conversationId}&select=${CONVERSATION_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That conversation was not found.");
  return rows[0];
}

async function conversationMembers(env: Env, conversationId: string): Promise<MemberRow[]> {
  return serviceRest<MemberRow[]>(
    env,
    "GET",
    `/conversation_members?conversation_id=eq.${conversationId}&select=conversation_id,user_id,role,last_read_at`,
  );
}

async function requireAcceptedFriend(env: Env, me: string, other: string): Promise<FriendshipRow> {
  requireUuid(other);
  if (me === other) throw new HttpError(400, "You cannot message yourself.");
  const row = await loadFriendship(env, me, other);
  if (!row || row.status !== "accepted") {
    throw new HttpError(403, "You can only message accepted friends.");
  }
  return row;
}

async function grantClip(env: Env, conversationId: string, clipId: string, grantedBy: string) {
  try {
    await serviceRest(env, "POST", "/conversation_clips", {
      conversation_id: conversationId,
      clip_id: clipId,
      granted_by: grantedBy,
    });
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
  }
}

async function loadSendableClip(env: Env, clipId: string, senderId: string): Promise<ClipCardRow> {
  const rows = await serviceRest<ClipCardRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&status=eq.ready&select=${CLIP_CARD_SELECT}`,
  );
  const clip = rows[0];
  if (!clip) throw new HttpError(404, "That clip is not available.");
  if (clip.visibility === "private") {
    throw new HttpError(403, "Private clips stay with you. Set Unlisted or Public before sending.");
  }
  const shareable = clip.visibility === "public" || clip.visibility === "unlisted";
  if (clip.user_id !== senderId && !shareable) {
    throw new HttpError(403, "You can only send clips you own.");
  }
  return clip;
}

async function messageCursor(env: Env, conversationId: string, before: string): Promise<string> {
  if (UUID.test(before)) {
    const rows = await serviceRest<MessageRow[]>(
      env,
      "GET",
      `/messages?id=eq.${before}&conversation_id=eq.${conversationId}&select=created_at`,
    );
    if (!rows[0]) throw new HttpError(400, "That message cursor was not found.");
    return rows[0].created_at;
  }
  if (Number.isNaN(Date.parse(before))) {
    throw new HttpError(400, "before must be a message id or timestamp.");
  }
  return before;
}

async function dmIdsForUser(env: Env, userId: string): Promise<Map<string, string>> {
  const rows = await serviceRest<ConversationRow[]>(
    env,
    "GET",
    `/conversations?type=eq.dm&or=(dm_user_a.eq.${userId},dm_user_b.eq.${userId})&select=id,dm_user_a,dm_user_b`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    const other = row.dm_user_a === userId ? row.dm_user_b : row.dm_user_a;
    if (other) map.set(other, row.id);
  }
  return map;
}

async function friendshipIndex(env: Env, userId: string): Promise<Map<string, FriendshipRow>> {
  const rows = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?or=(user_a.eq.${userId},user_b.eq.${userId})&select=${FRIENDSHIP_SELECT}`,
  );
  const map = new Map<string, FriendshipRow>();
  for (const row of rows) map.set(otherUser(row, userId), row);
  return map;
}

async function loadFriendship(env: Env, a: string, b: string): Promise<FriendshipRow | null> {
  const pair = ordered(a, b);
  const rows = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?user_a=eq.${pair.user_a}&user_b=eq.${pair.user_b}&select=${FRIENDSHIP_SELECT}`,
  );
  return rows[0] ?? null;
}

async function requireFriendship(env: Env, id: string): Promise<FriendshipRow> {
  requireUuid(id);
  const rows = await serviceRest<FriendshipRow[]>(
    env,
    "GET",
    `/friendships?id=eq.${id}&select=${FRIENDSHIP_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That friend request was not found.");
  return rows[0];
}

async function resolveTargetUser(env: Env, body: Record<string, unknown>): Promise<ProfileRow> {
  if (typeof body.userId === "string" && UUID.test(body.userId)) {
    const profile = await loadProfile(env, body.userId);
    if (!profile) throw new HttpError(404, "That account was not found.");
    return profile;
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!USERNAME.test(username)) throw new HttpError(400, "Search by a valid username.");
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?username_normalized=eq.${username.toLowerCase()}&select=${PROFILE_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That account was not found.");
  return rows[0];
}

async function loadProfile(env: Env, id: string): Promise<ProfileRow | null> {
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?id=eq.${id}&select=${PROFILE_SELECT}`,
  );
  return rows[0] ?? null;
}

async function loadSocialUsers(env: Env, ids: string[]): Promise<Map<string, SocialUser>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = new Map<string, SocialUser>();
  if (unique.length === 0) return users;
  const rows = await serviceRest<ProfileRow[]>(
    env,
    "GET",
    `/profiles?id=in.(${unique.join(",")})&select=${PROFILE_SELECT}`,
  );
  for (const row of rows) users.set(row.id, toSocialUser(row));
  return users;
}

async function insertNotifications(
  env: Env,
  rows: Array<{
    user_id: string;
    kind: NotificationKind;
    actor_id?: string | null;
    friendship_id?: string | null;
    conversation_id?: string | null;
    message_id?: string | null;
  }>,
) {
  const payload = rows
    .filter((row) => row.user_id && row.user_id !== row.actor_id)
    .map((row) => ({
      id: crypto.randomUUID(),
      user_id: row.user_id,
      kind: row.kind,
      actor_id: row.actor_id ?? null,
      friendship_id: row.friendship_id ?? null,
      conversation_id: row.conversation_id ?? null,
      message_id: row.message_id ?? null,
    }));
  if (payload.length === 0) return;
  await serviceRest(env, "POST", "/notifications", payload);
}

function toSocialUser(row: ProfileRow): SocialUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username || "Player",
    avatarUrl: row.avatar_url,
    verified: Boolean(row.is_verified),
  };
}

function relationshipOf(row: FriendshipRow | null, me: string): Relationship {
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  if (row.status === "blocked") return "blocked";
  if (row.status === "pending") return row.requested_by === me ? "outgoing" : "incoming";
  return "none";
}

function otherUser(row: FriendshipRow, me: string) {
  return row.user_a === me ? row.user_b : row.user_a;
}

function involves(row: FriendshipRow, userId: string) {
  return row.user_a === userId || row.user_b === userId;
}

function ordered(a: string, b: string) {
  return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
}

function uniqueIds(memberIds: unknown, userId: unknown): string[] {
  const values = [
    ...(Array.isArray(memberIds) ? memberIds : []),
    ...(typeof userId === "string" ? [userId] : []),
  ];
  const ids = values.filter((id): id is string => typeof id === "string" && UUID.test(id));
  return [...new Set(ids)];
}

function optionalTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (!title) return null;
  if (title.length > 64) throw new HttpError(400, "Group names must be 64 characters or fewer.");
  return title;
}

function chunkIds(ids: string[], size = 40): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const groups: string[][] = [];
  for (let i = 0; i < unique.length; i += size) groups.push(unique.slice(i, i + size));
  return groups;
}

function requireUuid(value: string) {
  if (!UUID.test(value)) throw new HttpError(400, "That id is not valid.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
