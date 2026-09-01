import type { Env } from "./env";
import { HttpError, json } from "./http";
import type { FollowState, FollowStatus, NotificationKind, Relationship, SocialUser } from "./social-types";
import { requireUser, serviceRest } from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const PROFILE_SELECT = "id,username,display_name,avatar_url,is_verified,is_private,created_at";

type FollowRow = {
  follower_id: string;
  following_id: string;
  status: FollowStatus;
  created_at: string;
  accepted_at: string | null;
};

type BlockRow = {
  blocker_id: string;
  blocked_id: string;
};

type FollowProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean;
  is_private?: boolean;
  created_at?: string;
};

export type FollowIndex = {
  outgoing: Map<string, FollowStatus>;
  incoming: Map<string, FollowStatus>;
  blocked: Set<string>;
};

export function emptyFollowState(): FollowState {
  return {
    viewerFollows: false,
    viewerFollowPending: false,
    followsViewer: false,
    incomingPending: false,
    mutual: false,
    blocked: false,
  };
}

export function relationshipFromFollow(state: FollowState): Relationship {
  if (state.blocked) return "blocked";
  if (state.mutual) return "friends";
  if (state.incomingPending) return "incoming";
  if (state.viewerFollowPending) return "outgoing";
  if (state.viewerFollows) return "following";
  if (state.followsViewer) return "follower";
  return "none";
}

export async function handleFollows(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  const follow = path.match(/^\/v1\/users\/([^/]+)\/follow$/);
  if (follow?.[1] && method === "POST") return followUser(request, env, follow[1]);
  if (follow?.[1] && method === "DELETE") return unfollowUser(request, env, follow[1]);

  const block = path.match(/^\/v1\/users\/([^/]+)\/block$/);
  if (block?.[1] && method === "POST") return blockUser(request, env, block[1]);
  if (block?.[1] && method === "DELETE") return unblockUser(request, env, block[1]);

  const accept = path.match(/^\/v1\/follow-requests\/([^/]+)\/accept$/);
  if (accept?.[1] && method === "POST") return acceptFollowRequest(request, env, accept[1]);
  const decline = path.match(/^\/v1\/follow-requests\/([^/]+)$/);
  if (decline?.[1] && method === "DELETE") return declineFollowRequest(request, env, decline[1]);

  if (path === "/v1/follows/requests" && method === "GET") return listFollowRequests(request, env);
  if (path === "/v1/following" && method === "GET") return listFollowing(request, env, url);
  if (path === "/v1/followers" && method === "GET") return listFollowers(request, env, url);

  return null;
}

export async function loadFollowState(env: Env, viewerId: string, targetId: string): Promise<FollowState> {
  if (viewerId === targetId) return emptyFollowState();
  const index = await loadFollowIndex(env, viewerId);
  return followStateFromIndex(index, targetId);
}

export async function loadFollowIndex(env: Env, viewerId: string): Promise<FollowIndex> {
  const [follows, blocks] = await Promise.all([
    serviceRest<FollowRow[]>(
      env,
      "GET",
      `/follows?or=(follower_id.eq.${viewerId},following_id.eq.${viewerId})&select=follower_id,following_id,status,created_at,accepted_at`,
    ),
    serviceRest<BlockRow[]>(
      env,
      "GET",
      `/blocks?or=(blocker_id.eq.${viewerId},blocked_id.eq.${viewerId})&select=blocker_id,blocked_id`,
    ),
  ]);
  const outgoing = new Map<string, FollowStatus>();
  const incoming = new Map<string, FollowStatus>();
  for (const row of follows) {
    if (row.follower_id === viewerId) outgoing.set(row.following_id, row.status);
    if (row.following_id === viewerId) incoming.set(row.follower_id, row.status);
  }
  const blocked = new Set<string>();
  for (const row of blocks) {
    blocked.add(row.blocker_id === viewerId ? row.blocked_id : row.blocker_id);
  }
  return { outgoing, incoming, blocked };
}

export function followStateFromIndex(index: FollowIndex, targetId: string): FollowState {
  const outgoing = index.outgoing.get(targetId) ?? null;
  const incoming = index.incoming.get(targetId) ?? null;
  const viewerFollows = outgoing === "accepted";
  const followsViewer = incoming === "accepted";
  return {
    viewerFollows,
    viewerFollowPending: outgoing === "pending",
    followsViewer,
    incomingPending: incoming === "pending",
    mutual: viewerFollows && followsViewer,
    blocked: index.blocked.has(targetId),
  };
}

export async function requireMutualFollow(env: Env, me: string, other: string): Promise<FollowState> {
  requireUuid(other);
  if (me === other) throw new HttpError(400, "You cannot message yourself.");
  const state = await loadFollowState(env, me, other);
  if (state.blocked || !state.mutual) {
    throw new HttpError(403, "You can only message people you both follow.");
  }
  return state;
}

export async function listMutualUserIds(env: Env, userId: string): Promise<string[]> {
  const index = await loadFollowIndex(env, userId);
  const ids: string[] = [];
  for (const [otherId, status] of index.outgoing) {
    if (status === "accepted" && index.incoming.get(otherId) === "accepted" && !index.blocked.has(otherId)) {
      ids.push(otherId);
    }
  }
  return ids;
}

export async function followTarget(
  env: Env,
  actorId: string,
  target: FollowProfile,
): Promise<{ follow: FollowState; status: FollowStatus }> {
  if (target.id === actorId) throw new HttpError(400, "You cannot follow yourself.");
  const existing = await loadFollowState(env, actorId, target.id);
  if (existing.blocked) throw new HttpError(403, "You cannot follow that account.");
  if (existing.viewerFollows) return { follow: existing, status: "accepted" };
  if (existing.viewerFollowPending) return { follow: existing, status: "pending" };

  const accepted = !target.is_private;
  const now = new Date().toISOString();
  try {
    await serviceRest(env, "POST", "/follows", {
      follower_id: actorId,
      following_id: target.id,
      status: accepted ? "accepted" : "pending",
      accepted_at: accepted ? now : null,
    });
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
    const raced = await loadFollowState(env, actorId, target.id);
    if (raced.viewerFollows) return { follow: raced, status: "accepted" };
    if (raced.viewerFollowPending) return { follow: raced, status: "pending" };
    throw caught;
  }

  if (!accepted) {
    await insertFollowNotification(env, {
      user_id: target.id,
      kind: "follow_request",
      actor_id: actorId,
    });
  }

  const follow = await loadFollowState(env, actorId, target.id);
  return { follow, status: accepted ? "accepted" : "pending" };
}

export async function unfollowTarget(env: Env, actorId: string, targetId: string): Promise<FollowState> {
  if (actorId === targetId) throw new HttpError(400, "You cannot unfollow yourself.");
  await serviceRest(
    env,
    "DELETE",
    `/follows?follower_id=eq.${actorId}&following_id=eq.${targetId}`,
  );
  return loadFollowState(env, actorId, targetId);
}

export async function acceptIncomingFollow(env: Env, actorId: string, followerId: string): Promise<FollowState> {
  requireUuid(followerId);
  if (actorId === followerId) throw new HttpError(400, "You cannot accept your own follow.");
  const state = await loadFollowState(env, actorId, followerId);
  if (state.blocked) throw new HttpError(403, "You cannot accept that request.");
  if (!state.incomingPending) {
    if (state.followsViewer) return state;
    throw new HttpError(404, "That follow request was not found.");
  }
  const now = new Date().toISOString();
  await serviceRest(
    env,
    "PATCH",
    `/follows?follower_id=eq.${followerId}&following_id=eq.${actorId}&status=eq.pending`,
    { status: "accepted", accepted_at: now },
  );
  await insertFollowNotification(env, {
    user_id: followerId,
    kind: "follow_accept",
    actor_id: actorId,
  });
  return loadFollowState(env, actorId, followerId);
}

export async function declineIncomingFollow(env: Env, actorId: string, followerId: string): Promise<void> {
  requireUuid(followerId);
  if (actorId === followerId) throw new HttpError(400, "You cannot decline your own follow.");
  const rows = await serviceRest<FollowRow[]>(
    env,
    "GET",
    `/follows?follower_id=eq.${followerId}&following_id=eq.${actorId}&status=eq.pending&select=follower_id`,
  );
  if (!rows[0]) throw new HttpError(404, "That follow request was not found.");
  await serviceRest(
    env,
    "DELETE",
    `/follows?follower_id=eq.${followerId}&following_id=eq.${actorId}&status=eq.pending`,
  );
}

export async function unfriendBoth(env: Env, actorId: string, otherId: string): Promise<void> {
  requireUuid(otherId);
  if (actorId === otherId) throw new HttpError(400, "You cannot unfriend yourself.");
  const state = await loadFollowState(env, actorId, otherId);
  if (state.blocked) {
    await serviceRest(env, "DELETE", `/blocks?blocker_id=eq.${actorId}&blocked_id=eq.${otherId}`);
    const after = await loadFollowState(env, actorId, otherId);
    if (after.blocked) throw new HttpError(403, "You cannot unfriend that account.");
    return;
  }
  if (!state.viewerFollows && !state.followsViewer && !state.viewerFollowPending && !state.incomingPending) {
    throw new HttpError(404, "You are not connected with that account.");
  }
  await deleteFollowPair(env, actorId, otherId);
}

export async function blockTargetById(env: Env, actorId: string, targetId: string): Promise<void> {
  requireUuid(targetId);
  if (actorId === targetId) throw new HttpError(400, "You cannot block yourself.");
  try {
    await serviceRest(env, "POST", "/blocks", { blocker_id: actorId, blocked_id: targetId });
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
  }
  try {
    await deleteFollowPair(env, actorId, targetId);
  } catch {
    // Block is already authoritative for authorization.
  }
}

export async function unblockTargetById(env: Env, actorId: string, targetId: string): Promise<void> {
  requireUuid(targetId);
  await serviceRest(env, "DELETE", `/blocks?blocker_id=eq.${actorId}&blocked_id=eq.${targetId}`);
}

export async function resolveFollowUsername(env: Env, username: string): Promise<FollowProfile> {
  const decoded = decodeURIComponent(username);
  if (!USERNAME.test(decoded)) throw new HttpError(404, "That account was not found.");
  const rows = await serviceRest<FollowProfile[]>(
    env,
    "GET",
    `/profiles?username_normalized=eq.${decoded.toLowerCase()}&select=${PROFILE_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That account was not found.");
  return rows[0];
}

export async function loadFollowProfile(env: Env, id: string): Promise<FollowProfile | null> {
  const rows = await serviceRest<FollowProfile[]>(env, "GET", `/profiles?id=eq.${id}&select=${PROFILE_SELECT}`);
  return rows[0] ?? null;
}

async function followUser(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const target = await resolveFollowUsername(env, username);
  const result = await followTarget(env, user.id, target);
  return json({ follow: result.follow, status: result.status });
}

async function unfollowUser(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const target = await resolveFollowUsername(env, username);
  const follow = await unfollowTarget(env, user.id, target.id);
  return json({ follow, status: follow.viewerFollows ? "accepted" : follow.viewerFollowPending ? "pending" : null });
}

async function acceptFollowRequest(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const follower = await resolveFollowUsername(env, username);
  const follow = await acceptIncomingFollow(env, user.id, follower.id);
  return json({ follow, status: follow.followsViewer ? "accepted" : null });
}

async function declineFollowRequest(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const follower = await resolveFollowUsername(env, username);
  await declineIncomingFollow(env, user.id, follower.id);
  return json({ ok: true });
}

async function blockUser(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const target = await resolveFollowUsername(env, username);
  await blockTargetById(env, user.id, target.id);
  return json({ ok: true });
}

async function unblockUser(request: Request, env: Env, username: string): Promise<Response> {
  const user = await requireUser(request, env);
  const target = await resolveFollowUsername(env, username);
  await unblockTargetById(env, user.id, target.id);
  return json({ ok: true });
}

async function listFollowRequests(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const rows = await serviceRest<FollowRow[]>(
    env,
    "GET",
    `/follows?or=(follower_id.eq.${user.id},following_id.eq.${user.id})&status=eq.pending&select=follower_id,following_id,status,created_at,accepted_at&order=created_at.desc`,
  );
  const people = await loadFollowUsers(
    env,
    rows.flatMap((row) => [row.follower_id, row.following_id]),
  );
  const me = people.get(user.id);
  const incoming = [];
  const outgoing = [];
  for (const row of rows) {
    const from = people.get(row.follower_id);
    const to = people.get(row.following_id);
    if (!from || !to) continue;
    const item = { id: row.follower_id === user.id ? row.following_id : row.follower_id, createdAt: row.created_at, from, to };
    if (row.follower_id === user.id) outgoing.push(item);
    else incoming.push(item);
  }
  if (!me) {
    return json({ incoming, outgoing });
  }
  return json({ incoming, outgoing });
}

async function listFollowing(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const limit = listLimit(url);
  const rows = await serviceRest<FollowRow[]>(
    env,
    "GET",
    `/follows?follower_id=eq.${user.id}&status=eq.accepted&select=follower_id,following_id,status,created_at,accepted_at&order=accepted_at.desc&limit=${limit}`,
  );
  const people = await loadFollowUsers(
    env,
    rows.map((row) => row.following_id),
  );
  return json({
    users: rows
      .map((row) => {
        const person = people.get(row.following_id);
        if (!person) return null;
        return { ...person, since: row.accepted_at ?? row.created_at };
      })
      .filter((row): row is SocialUser & { since: string } => Boolean(row)),
  });
}

async function listFollowers(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  const limit = listLimit(url);
  const rows = await serviceRest<FollowRow[]>(
    env,
    "GET",
    `/follows?following_id=eq.${user.id}&status=eq.accepted&select=follower_id,following_id,status,created_at,accepted_at&order=accepted_at.desc&limit=${limit}`,
  );
  const people = await loadFollowUsers(
    env,
    rows.map((row) => row.follower_id),
  );
  return json({
    users: rows
      .map((row) => {
        const person = people.get(row.follower_id);
        if (!person) return null;
        return { ...person, since: row.accepted_at ?? row.created_at };
      })
      .filter((row): row is SocialUser & { since: string } => Boolean(row)),
  });
}

async function deleteFollowPair(env: Env, a: string, b: string) {
  await serviceRest(
    env,
    "DELETE",
    `/follows?or=(and(follower_id.eq.${a},following_id.eq.${b}),and(follower_id.eq.${b},following_id.eq.${a}))`,
  );
}

async function loadFollowUsers(env: Env, ids: string[]): Promise<Map<string, SocialUser>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const users = new Map<string, SocialUser>();
  if (unique.length === 0) return users;
  const rows = await serviceRest<FollowProfile[]>(
    env,
    "GET",
    `/profiles?id=in.(${unique.join(",")})&select=${PROFILE_SELECT}`,
  );
  for (const row of rows) {
    users.set(row.id, {
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username || "Player",
      avatarUrl: row.avatar_url,
      verified: Boolean(row.is_verified),
    });
  }
  return users;
}

async function insertFollowNotification(
  env: Env,
  row: { user_id: string; kind: NotificationKind; actor_id: string },
) {
  if (row.user_id === row.actor_id) return;
  await serviceRest(env, "POST", "/notifications", {
    id: crypto.randomUUID(),
    user_id: row.user_id,
    kind: row.kind,
    actor_id: row.actor_id,
    friendship_id: null,
    conversation_id: null,
    message_id: null,
  });
}

function listLimit(url: URL) {
  const raw = Number(url.searchParams.get("limit"));
  return Number.isFinite(raw) && raw >= 1 ? Math.min(100, Math.floor(raw)) : 48;
}

function requireUuid(value: string) {
  if (!UUID.test(value)) throw new HttpError(400, "That account was not found.");
}
