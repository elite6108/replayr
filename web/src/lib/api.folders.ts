import { apiUrl } from "./supabase";
import { readApiJson } from "./http";

export type PublicFolderOwner = {
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type PublicFolderClip = {
  id: string;
  title: string | null;
  durationMs: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
};

export type PublicFolder = {
  name: string;
  description: string | null;
  owner: PublicFolderOwner | null;
  clipCount: number;
  allowDownloads: boolean;
  coverThumbnailUrl: string | null;
  clips: PublicFolderClip[];
};

export async function fetchPublicFolder(token: string): Promise<PublicFolder> {
  const response = await fetch(apiUrl(`/v1/public/folders/${encodeURIComponent(token)}`), {
    headers: { accept: "application/json" },
  });
  const body = await readApiJson<{ folder: PublicFolder }>(response, "That folder was not found.");
  return body.folder;
}

export async function fetchPublicFolderPlayback(token: string, clipId: string): Promise<string> {
  const response = await fetch(
    apiUrl(`/v1/public/folders/${encodeURIComponent(token)}/clips/${clipId}/playback`),
    { headers: { accept: "application/json" } },
  );
  const body = await readApiJson<{ playbackUrl?: string }>(response, "That clip was not found in this folder.");
  if (!body.playbackUrl) throw new Error("That clip was not found in this folder.");
  return body.playbackUrl;
}

export async function fetchPublicFolderDownload(token: string, clipId: string): Promise<string> {
  const response = await fetch(
    apiUrl(`/v1/public/folders/${encodeURIComponent(token)}/clips/${clipId}/download`),
    { headers: { accept: "application/json" } },
  );
  const body = await readApiJson<{ downloadUrl?: string }>(response, "Downloads are disabled for this folder.");
  if (!body.downloadUrl) throw new Error("Downloads are disabled for this folder.");
  return body.downloadUrl;
}
