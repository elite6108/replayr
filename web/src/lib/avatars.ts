import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

async function apiFetch(input: string, init: RequestInit, fallback: string) {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("Could not reach the API. Confirm the local worker is running.");
  }
}

export async function uploadOwnAvatar(token: string, file: File): Promise<string> {
  if (!ALLOWED.has(file.type)) throw new Error("Use a JPG, PNG, or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Avatar must be 5 MB or smaller.");
  const done = await readApiJson<{ avatarUrl: string }>(
    await apiFetch(
      apiUrl("/v1/me/avatar"),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": file.type },
        body: file,
      },
      "Could not upload the avatar.",
    ),
    "Could not upload the avatar.",
  );
  return done.avatarUrl;
}

export async function deleteOwnAvatar(token: string): Promise<void> {
  await readApiJson(
    await apiFetch(
      apiUrl("/v1/me/avatar"),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      },
      "Could not remove the avatar.",
    ),
    "Could not remove the avatar.",
  );
}
