import { publicApiUrl } from "../branding";
import { readApiJson } from "../utils/http";
import type {
  AddFolderClipsBody,
  CreateFolderBody,
  CreateFolderInviteBody,
  Folder,
  FolderDetail,
  FolderInvite,
  FolderInviteResponse,
  FolderInvitesResponse,
  FolderMember,
  FolderMembersResponse,
  FolderPlaybackResponse,
  FolderPublicLinkResponse,
  FolderPublicShare,
  FolderResponse,
  FoldersResponse,
  IncomingFolderInvitesResponse,
  TransferFolderOwnershipBody,
  UpdateFolderBody,
  UpdateFolderMemberBody,
  CreateFolderEditBody,
  FolderActivity,
  FolderActivityResponse,
  FolderEdit,
  FolderEditResponse,
  FolderEditsResponse,
  RenderFolderEditBody,
  UpdateFolderEditBody,
} from "./social-types";

export { folderAccessLabel, folderRoleLabel, isFolderEditConflict, mergeFolderEditDocument } from "./social-types";

function authHeaders(accessToken: string, asJson = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (asJson) headers["content-type"] = "application/json";
  return headers;
}

export async function listFolders(accessToken: string): Promise<Folder[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FoldersResponse>(response, "Could not load folders.");
  return body.folders ?? [];
}

export async function getFolder(accessToken: string, folderId: string): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not load that folder.");
  return body.folder;
}

export async function createFolder(accessToken: string, payload: CreateFolderBody): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not create that folder.");
  return body.folder;
}

export async function updateFolder(accessToken: string, folderId: string, payload: UpdateFolderBody): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not update that folder.");
  return body.folder;
}

export async function deleteFolder(accessToken: string, folderId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not delete that folder.");
}

export async function addFolderClips(accessToken: string, folderId: string, payload: AddFolderClipsBody): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not add those clips.");
  return body.folder;
}

export async function removeFolderClip(accessToken: string, folderId: string, clipId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not remove that clip from the folder.");
}

export async function listSharedFolders(accessToken: string): Promise<Folder[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/shared`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FoldersResponse>(response, "Could not load shared folders.");
  return body.folders ?? [];
}

export async function listIncomingFolderInvites(accessToken: string): Promise<FolderInvite[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/invites`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<IncomingFolderInvitesResponse>(response, "Could not load folder invites.");
  return body.invites ?? [];
}

export async function listFolderMembers(accessToken: string, folderId: string): Promise<FolderMembersResponse> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/members`, {
    headers: authHeaders(accessToken),
  });
  return readApiJson<FolderMembersResponse>(response, "Could not load folder members.");
}

export async function listFolderInvites(accessToken: string, folderId: string): Promise<FolderInvite[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/invites`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderInvitesResponse>(response, "Could not load folder invites.");
  return body.invites ?? [];
}

export async function createFolderInvite(
  accessToken: string,
  folderId: string,
  payload: CreateFolderInviteBody,
): Promise<FolderInviteResponse> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/invites`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  return readApiJson<FolderInviteResponse>(response, "Could not send that invite.");
}

export async function acceptFolderInvite(accessToken: string, folderId: string, inviteId: string): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/invites/${inviteId}/accept`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not accept that invite.");
  return body.folder;
}

export async function deleteFolderInvite(accessToken: string, folderId: string, inviteId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/invites/${inviteId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not update that invite.");
}

export async function updateFolderMemberRole(
  accessToken: string,
  folderId: string,
  userId: string,
  payload: UpdateFolderMemberBody,
): Promise<FolderMember> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/members/${userId}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<{ member: FolderMember }>(response, "Could not change that role.");
  return body.member;
}

export async function removeFolderMember(accessToken: string, folderId: string, userId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/members/${userId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not remove that person.");
}

export async function leaveFolder(accessToken: string, folderId: string): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/members/me`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not leave that folder.");
}

export async function transferFolderOwnership(
  accessToken: string,
  folderId: string,
  payload: TransferFolderOwnershipBody,
): Promise<FolderDetail> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/transfer-ownership`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderResponse>(response, "Could not transfer ownership.");
  return body.folder;
}

export async function playFolderClip(accessToken: string, folderId: string, clipId: string): Promise<string> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/playback`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderPlaybackResponse>(response, "Could not play that clip.");
  if (!body.playbackUrl) throw new Error("Could not play that clip.");
  return body.playbackUrl;
}

export async function enableFolderPublicLink(accessToken: string, folderId: string): Promise<FolderPublicShare> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/public-link`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderPublicLinkResponse>(response, "Could not enable the public link.");
  return body.publicShare;
}

export async function disableFolderPublicLink(accessToken: string, folderId: string): Promise<FolderPublicShare> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/public-link`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderPublicLinkResponse>(response, "Could not disable the public link.");
  return body.publicShare;
}

export async function regenerateFolderPublicLink(accessToken: string, folderId: string): Promise<FolderPublicShare> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/public-link/regenerate`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderPublicLinkResponse>(response, "Could not regenerate that link.");
  return body.publicShare;
}

export async function updateFolderPublicDownloads(
  accessToken: string,
  folderId: string,
  allowDownloads: boolean,
): Promise<FolderPublicShare> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/public-link`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({ allowDownloads }),
  });
  const body = await readApiJson<FolderPublicLinkResponse>(response, "Could not update download access.");
  return body.publicShare;
}

export async function listFolderEdits(accessToken: string, folderId: string, clipId: string): Promise<FolderEdit[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderEditsResponse>(response, "Could not load folder edits.");
  return body.edits ?? [];
}

export async function createFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  payload: CreateFolderEditBody = {},
): Promise<FolderEdit> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderEditResponse>(response, "Could not create that edit.");
  return body.edit;
}

export async function getFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  editId: string,
): Promise<FolderEdit> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits/${editId}`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderEditResponse>(response, "Could not load that edit.");
  return body.edit;
}

export async function updateFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  editId: string,
  payload: UpdateFolderEditBody,
): Promise<FolderEdit> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits/${editId}`, {
    method: "PATCH",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderEditResponse>(response, "Could not save that edit.");
  return body.edit;
}

export async function deleteFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  editId: string,
): Promise<void> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits/${editId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not delete that edit.");
}

export async function duplicateFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  editId: string,
): Promise<FolderEdit> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits/${editId}/duplicate`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderEditResponse>(response, "Could not duplicate that edit.");
  return body.edit;
}

export async function renderFolderEdit(
  accessToken: string,
  folderId: string,
  clipId: string,
  editId: string,
  payload: RenderFolderEditBody,
): Promise<FolderEdit> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/clips/${clipId}/edits/${editId}/render`, {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<FolderEditResponse>(response, "Could not save that rendered copy.");
  return body.edit;
}

export async function listFolderActivity(accessToken: string, folderId: string): Promise<FolderActivity[]> {
  const response = await fetch(`${publicApiUrl()}/v1/folders/${folderId}/activity`, {
    headers: authHeaders(accessToken),
  });
  const body = await readApiJson<FolderActivityResponse>(response, "Could not load folder activity.");
  return body.activities ?? [];
}
