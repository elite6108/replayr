import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

/**
 * Frozen Worker JSON contract for friends and public profiles.
 * Copied from worker/src/social-types.ts — no monorepo package.
 */

export type FriendshipStatus = "pending" | "accepted" | "blocked";
export type Relationship = "none" | "outgoing" | "incoming" | "friends" | "following" | "follower" | "blocked";

export type FollowState = {
  viewerFollows: boolean;
  viewerFollowPending: boolean;
  followsViewer: boolean;
  incomingPending: boolean;
  mutual: boolean;
  blocked: boolean;
};

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
  follow?: FollowState;
  relationship: Relationship;
  isPrivate: boolean;
  locked: boolean;
  clips: PublicClipCard[];
  posts: ProfilePost[];
};

function authHeaders(accessToken?: string | null): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  return readApiJson<T>(response, fallback);
}

export async function fetchFriends(accessToken: string): Promise<Friend[]> {
  const response = await fetch(apiUrl("/v1/friends"), { headers: authHeaders(accessToken) });
  const body = await readJson<FriendsResponse>(response, "Could not load friends.");
  return body.friends ?? [];
}

export async function fetchFriendRequests(accessToken: string): Promise<FriendRequestsResponse> {
  const response = await fetch(apiUrl("/v1/friends/requests"), { headers: authHeaders(accessToken) });
  const body = await readJson<FriendRequestsResponse>(response, "Could not load friend requests.");
  return { incoming: body.incoming ?? [], outgoing: body.outgoing ?? [] };
}

export async function createFriendRequest(accessToken: string, body: CreateFriendRequestBody): Promise<FriendRequest> {
  const response = await fetch(apiUrl("/v1/friends/requests"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<{ request: FriendRequest }>(response, "Could not send that friend request.");
  return payload.request;
}

export async function acceptFriendRequest(accessToken: string, requestId: string): Promise<Friend> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}/accept`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readJson<{ friend: Friend }>(response, "Could not accept that request.");
  return body.friend;
}

export async function declineFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}/decline`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not decline that request.");
}

export async function cancelFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/requests/${requestId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not cancel that request.");
}

export async function unfriendUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/${userId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not remove that friend.");
}

export async function blockUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/${userId}/block`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not block that account.");
}

export async function searchUsers(accessToken: string, query: string): Promise<UsersSearchResponse["users"]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const response = await fetch(apiUrl(`/v1/users/search?q=${encodeURIComponent(q)}`), {
    headers: authHeaders(accessToken),
  });
  const body = await readJson<UsersSearchResponse>(response, "Could not search people.");
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
  const response = await fetch(apiUrl(`/v1/users/${encodeURIComponent(username)}`), {
    headers: authHeaders(accessToken),
  });
  return normalizeProfile(await readJson<UserProfileResponse>(response, "That account was not found."));
}

export async function fetchUserPosts(username: string, accessToken?: string | null, page = 1, limit = 24) {
  const response = await fetch(
    apiUrl(`/v1/users/${encodeURIComponent(username)}/posts?page=${page}&limit=${limit}`),
    { headers: authHeaders(accessToken) },
  );
  const payload = await readJson<{ posts?: ProfilePost[] }>(response, "Could not load posts.");
  return payload.posts ?? [];
}

export async function createProfilePost(accessToken: string, body: string, clipId?: string) {
  const response = await fetch(apiUrl("/v1/posts"), {
    method: "POST",
    headers: { ...authHeaders(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ body, clipId }),
  });
  const payload = await readJson<{ post?: ProfilePost }>(response, "Could not publish that post.");
  if (!payload.post) throw new Error("Could not publish that post.");
  return payload.post;
}

export async function deleteProfilePost(accessToken: string, postId: string) {
  const response = await fetch(apiUrl(`/v1/posts/${postId}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readJson<{ ok?: boolean }>(response, "Could not delete that post.");
}

export function personName(user: Pick<SocialUser, "displayName" | "username">): string {
  return user.displayName || user.username || "Player";
}

export async function fetchUserSuggestions(accessToken: string): Promise<UserSuggestionsResponse["users"]> {
  const response = await fetch(apiUrl("/v1/users/suggestions"), { headers: authHeaders(accessToken) });
  const body = await readJson<UserSuggestionsResponse>(response, "Could not load suggestions.");
  return body.users ?? [];
}
