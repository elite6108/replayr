import { publicApiUrl } from "../branding";
import { readApiJson } from "../utils/http";
import type {
  CreateFriendRequestBody,
  Friend,
  FriendRequest,
  FriendRequestsResponse,
  FriendsResponse,
  UserProfileResponse,
  UserSuggestionsResponse,
  UsersSearchResponse,
} from "./social-types";

function authHeaders(accessToken: string, json = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function readApi<T>(response: Response, fallback: string): Promise<T> {
  return readApiJson<T>(response, fallback);
}

export async function fetchFriends(accessToken: string): Promise<Friend[]> {
  const response = await fetch(`${publicApiUrl()}/v1/friends`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<FriendsResponse>(response, "Could not load friends.");
  return body.friends ?? [];
}

export async function fetchFriendRequests(accessToken: string): Promise<FriendRequestsResponse> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/requests`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<FriendRequestsResponse>(response, "Could not load friend requests.");
  return { incoming: body.incoming ?? [], outgoing: body.outgoing ?? [] };
}

export async function createFriendRequest(accessToken: string, payload: CreateFriendRequestBody): Promise<FriendRequest> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/requests`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApi<{ request: FriendRequest }>(response, "Could not send that friend request.");
  return body.request;
}

export async function acceptFriendRequest(accessToken: string, requestId: string): Promise<Friend> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/requests/${requestId}/accept`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApi<{ friend: Friend }>(response, "Could not accept that request.");
  return body.friend;
}

export async function declineFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/requests/${requestId}/decline`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  await readApi<{ ok?: boolean }>(response, "Could not decline that request.");
}

export async function cancelFriendRequest(accessToken: string, requestId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/requests/${requestId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApi<{ ok?: boolean }>(response, "Could not cancel that request.");
}

export async function unfriendUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/${userId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApi<{ ok?: boolean }>(response, "Could not unfriend that account.");
}

export async function blockUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/friends/${userId}/block`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  await readApi<{ ok?: boolean }>(response, "Could not block that account.");
}

export async function searchUsers(accessToken: string, query: string): Promise<UsersSearchResponse["users"]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const response = await fetch(`${publicApiUrl()}/v1/users/search?q=${encodeURIComponent(q)}`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<UsersSearchResponse>(response, "Could not search accounts.");
  return body.users ?? [];
}

export async function fetchUserProfile(accessToken: string | null | undefined, username: string): Promise<UserProfileResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${publicApiUrl()}/v1/users/${encodeURIComponent(username)}`, { headers });
  return readApi<UserProfileResponse>(response, "That account was not found.");
}

export async function fetchUserSuggestions(accessToken: string): Promise<UserSuggestionsResponse["users"]> {
  const response = await fetch(`${publicApiUrl()}/v1/users/suggestions`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApi<UserSuggestionsResponse>(response, "Could not load suggestions.");
  return body.users ?? [];
}
