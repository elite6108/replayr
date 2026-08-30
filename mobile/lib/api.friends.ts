import { readApiError, readApiJson } from "./http";
import { apiUrl } from "./supabase";

export type FriendshipStatus = "pending" | "accepted" | "blocked";
export type Relationship = "none" | "outgoing" | "incoming" | "friends" | "blocked";
export type NotificationKind = "friend_request" | "friend_accept" | "message" | "group_invite";

export type SocialUser = {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
};

export type Friend = SocialUser & {
  friendshipId: string;
  since: string;
  dmId: string | null;
};

export type FriendRequest = {
  id: string;
  createdAt: string;
  from: SocialUser;
  to: SocialUser;
};

export type FriendRequestsResponse = {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
};

export type FriendsResponse = {
  friends: Friend[];
};

export type CreateFriendRequestBody = {
  username?: string;
  userId?: string;
};

export type UsersSearchResponse = {
  users: Array<SocialUser & { relationship: Relationship }>;
};

export type UserSuggestionsResponse = {
  users: Array<SocialUser & { relationship: Relationship }>;
};

export type FriendClipsResponse = {
  clips: PublicClipCard[];
};

export type PublicClipCard = {
  id: string;
  title: string | null;
  description?: string | null;
  slug: string;
  durationMs: number | null;
  createdAt: string;
  viewCount: number;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  game: { name: string; slug: string; coverUrl: string | null } | null;
  author: {
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    verified?: boolean;
  };
  likeCount: number;
  commentCount: number;
  liked: boolean;
};

export type ProfilePost = {
  id: string;
  body: string;
  createdAt: string;
  clip: PublicClipCard | null;
  author: SocialUser;
};

export type UserProfileResponse = {
  user: SocialUser & {
    bio: string | null;
    clipCount: number;
    createdAt: string;
  };
  relationship: Relationship;
  isPrivate: boolean;
  locked: boolean;
  clips: PublicClipCard[];
  posts: ProfilePost[];
};

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  actor: SocialUser | null;
  friendshipId: string | null;
  conversationId: string | null;
  messageId: string | null;
};

export type NotificationsResponse = {
  notifications: NotificationItem[];
};

export type ReadNotificationsBody = {
  ids?: string[];
};

export type ReadNotificationsResponse = {
  read: true;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  return readApiJson<T>(response, fallback);
}

function authHeaders(accessToken: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${accessToken}` };
}

export function socialName(user: Pick<SocialUser, "displayName" | "username"> | null | undefined) {
  return user?.displayName || user?.username || "Player";
}

export function socialHandle(user: Pick<SocialUser, "username"> | null | undefined) {
  return user?.username ? `@${user.username}` : "";
}

export async function fetchFriends(accessToken: string): Promise<Friend[]> {
  const response = await fetch(apiUrl("/v1/friends"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<FriendsResponse>(response, "Could not load friends.");
  return body.friends ?? [];
}

export async function fetchFriendRequests(accessToken: string): Promise<FriendRequestsResponse> {
  const response = await fetch(apiUrl("/v1/friends/requests"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<FriendRequestsResponse>(response, "Could not load friend requests.");
  return { incoming: body.incoming ?? [], outgoing: body.outgoing ?? [] };
}

export async function sendFriendRequest(accessToken: string, body: CreateFriendRequestBody): Promise<FriendRequest> {
  const response = await fetch(apiUrl("/v1/friends/requests"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readApiJson<{ request?: FriendRequest }>(response, "Could not send that friend request.");
  if (!payload.request) throw new Error("Could not send that friend request.");
  return payload.request;
}

export async function acceptFriendRequest(accessToken: string, requestId: string): Promise<Friend> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}/accept`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<{ friend?: Friend }>(response, "Could not accept that request.");
  if (!body.friend) throw new Error("Could not accept that request.");
  return body.friend;
}

export async function declineFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}/decline`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not decline that request."));
}

export async function cancelFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not cancel that request."));
}

export async function unfriendUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/${userId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not remove that friend."));
}

export async function blockUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/${userId}/block`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not block that account."));
}

export async function searchUsers(accessToken: string, query: string): Promise<UsersSearchResponse["users"]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const response = await fetch(apiUrl(`/v1/users/search?q=${encodeURIComponent(q)}`), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<UsersSearchResponse>(response, "Could not search accounts.");
  return body.users ?? [];
}

function normalizeProfile(body: UserProfileResponse): UserProfileResponse {
  return {
    ...body,
    isPrivate: Boolean(body.isPrivate),
    locked: Boolean(body.locked),
    clips: body.clips ?? [],
    posts: body.posts ?? [],
  };
}

export async function fetchUserProfile(username: string, accessToken?: string | null): Promise<UserProfileResponse> {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) (headers as Record<string, string>).authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl(`/v1/users/${encodeURIComponent(username)}`), { headers });
  return normalizeProfile(await readApiJson<UserProfileResponse>(response, "That account was not found."));
}

export async function fetchUserPosts(username: string, accessToken?: string | null, page = 1, limit = 24) {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) (headers as Record<string, string>).authorization = `Bearer ${accessToken}`;
  const response = await fetch(
    apiUrl(`/v1/users/${encodeURIComponent(username)}/posts?page=${page}&limit=${limit}`),
    { headers },
  );
  const payload = await readApiJson<{ posts?: ProfilePost[] }>(response, "Could not load posts.");
  return payload.posts ?? [];
}

export async function createProfilePost(accessToken: string, body: string, clipId?: string) {
  const response = await fetch(apiUrl("/v1/posts"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ body, clipId }),
  });
  const payload = await readApiJson<{ post?: ProfilePost }>(response, "Could not publish that post.");
  if (!payload.post) throw new Error("Could not publish that post.");
  return payload.post;
}

export async function deleteProfilePost(accessToken: string, postId: string) {
  const response = await fetch(apiUrl(`/v1/posts/${postId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not delete that post.");
}

export async function fetchUserSuggestions(accessToken: string): Promise<UsersSearchResponse["users"]> {
  const response = await fetch(apiUrl("/v1/users/suggestions"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<UsersSearchResponse>(response, "Could not load suggestions.");
  return body.users ?? [];
}

export async function fetchNotifications(accessToken: string, limit = 30): Promise<NotificationItem[]> {
  const response = await fetch(apiUrl(`/v1/notifications?limit=${Math.min(50, Math.max(1, limit))}`), {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<NotificationsResponse>(response, "Could not load notifications.");
  return body.notifications ?? [];
}

export async function readNotifications(accessToken: string, ids?: string[]): Promise<void> {
  const response = await fetch(apiUrl("/v1/notifications/read"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(ids ? { ids } : {}),
  });
  await readApiJson<ReadNotificationsResponse>(response, "Could not mark notifications read.");
}
