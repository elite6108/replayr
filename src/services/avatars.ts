import { publicApiUrl } from "../branding";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

async function apiFetch(input: string, init: RequestInit) {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("Could not reach the API.");
  }
}

export async function uploadOwnAvatar(token: string, file: File): Promise<string> {
  if (!ALLOWED.has(file.type)) throw new Error("Use a JPG, PNG, or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Avatar must be 5 MB or smaller.");
  const done = await readJson<{ avatarUrl: string }>(
    await apiFetch(`${publicApiUrl()}/v1/me/avatar`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": file.type },
      body: file,
    }),
    "Could not upload the avatar.",
  );
  return done.avatarUrl;
}

export async function deleteOwnAvatar(token: string): Promise<void> {
  await readJson(
    await apiFetch(`${publicApiUrl()}/v1/me/avatar`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    "Could not remove the avatar.",
  );
}
