import { readApiError, readApiJson } from "./http";
import { apiUrl } from "./supabase";
import type { FollowState, FollowStatus, FriendRequest, SocialUser } from "./api.friends";

export type FollowActionResponse = {
  follow: FollowState;
  status: FollowStatus | null;
};

export type FollowListItem = SocialUser & { since: string };

function authHeaders(accessToken: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${accessToken}` };
}

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

export async function followUser(accessToken: string, username: string): Promise<FollowActionResponse> {
  const response = await fetch(apiUrl(`/v1/users/${encodeURIComponent(username)}/follow`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  return readApiJson<FollowActionResponse>(response, "Could not follow that account.");
}

export async function unfollowUser(accessToken: string, username: string): Promise<FollowActionResponse> {
  const response = await fetch(apiUrl(`/v1/users/${encodeURIComponent(username)}/follow`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  return readApiJson<FollowActionResponse>(response, "Could not unfollow that account.");
}

export async function acceptFollowRequest(accessToken: string, username: string): Promise<FollowActionResponse> {
  const response = await fetch(apiUrl(`/v1/follow-requests/${encodeURIComponent(username)}/accept`), {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  return readApiJson<FollowActionResponse>(response, "Could not accept that request.");
}

export async function declineFollowRequest(accessToken: string, username: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/follow-requests/${encodeURIComponent(username)}`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) throw new Error(await readApiError(response, "Could not decline that request."));
}

export async function fetchFollowing(accessToken: string): Promise<FollowListItem[]> {
  const response = await fetch(apiUrl("/v1/following"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ users?: FollowListItem[] }>(response, "Could not load following.");
  return body.users ?? [];
}

export async function fetchFollowers(accessToken: string): Promise<FollowListItem[]> {
  const response = await fetch(apiUrl("/v1/followers"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ users?: FollowListItem[] }>(response, "Could not load followers.");
  return body.users ?? [];
}

export async function fetchFollowRequests(accessToken: string): Promise<{
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}> {
  const response = await fetch(apiUrl("/v1/follows/requests"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<{ incoming?: FriendRequest[]; outgoing?: FriendRequest[] }>(
    response,
    "Could not load follow requests.",
  );
  return { incoming: body.incoming ?? [], outgoing: body.outgoing ?? [] };
}

export function followLabel(follow: FollowState): "Follow" | "Follow back" | "Requested" | "Following" {
  if (follow.viewerFollowPending) return "Requested";
  if (follow.viewerFollows) return "Following";
  if (follow.followsViewer) return "Follow back";
  return "Follow";
}
