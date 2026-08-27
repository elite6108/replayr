import type { Env } from "./env";

const API_BASE = "https://video.bunnycdn.com";

export const WATERMARK_RENDER_VERSION = 1;
export const WATERMARK_PROCESSOR = "bunny";

export type BunnyVideoStatus =
  | 0 // Created
  | 1 // Uploaded
  | 2 // Processing
  | 3 // Transcoding
  | 4 // Finished
  | 5 // Error
  | 6 // UploadFailed
  | number;

export interface BunnyVideo {
  guid: string;
  title: string;
  status: BunnyVideoStatus;
  width?: number;
  height?: number;
  encodeProgress?: number;
  hasMP4Fallback?: boolean;
  availableResolutions?: string | null;
}

export interface BunnyResolutionRef {
  resolution?: string | number | null;
  height?: number | null;
  path?: string | null;
}

export interface BunnyResolutionsInfo {
  availableResolutions?: string[] | string | null;
  mp4Resolutions?: BunnyResolutionRef[] | null;
}

export interface BunnyFetchResult {
  success: boolean;
  message?: string | null;
  statusCode?: number;
  /** Present on some Bunny responses even when undocumented. */
  guid?: string | null;
  id?: string | null;
}

function requireBunnyConfig(env: Env): {
  libraryId: string;
  apiKey: string;
  cdnHostname: string;
} {
  const libraryId = env.BUNNY_STREAM_LIBRARY_ID?.trim();
  const apiKey = env.BUNNY_STREAM_API_KEY?.trim();
  const cdnHostname = env.BUNNY_STREAM_CDN_HOSTNAME?.trim();
  if (!libraryId || !apiKey || !cdnHostname) {
    throw new Error("Bunny Stream is not configured.");
  }
  return { libraryId, apiKey, cdnHostname };
}

export function bunnyConfigured(env: Env): boolean {
  return Boolean(
    env.BUNNY_STREAM_LIBRARY_ID?.trim() &&
      env.BUNNY_STREAM_API_KEY?.trim() &&
      env.BUNNY_STREAM_CDN_HOSTNAME?.trim(),
  );
}

async function bunnyRequest<T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { libraryId, apiKey } = requireBunnyConfig(env);
  const url = `${API_BASE}/library/${libraryId}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      AccessKey: apiKey,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as { message?: unknown }).message ?? text)
        : text || `Bunny HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export async function createBunnyVideo(env: Env, title: string): Promise<BunnyVideo> {
  return bunnyRequest<BunnyVideo>(env, "POST", "/videos", { title });
}

export async function fetchBunnyVideo(
  env: Env,
  options: { url: string; title?: string; headers?: Record<string, string> },
): Promise<BunnyFetchResult> {
  return bunnyRequest<BunnyFetchResult>(env, "POST", "/videos/fetch", {
    url: options.url,
    title: options.title,
    headers: options.headers,
  });
}

export async function getBunnyVideo(env: Env, videoId: string): Promise<BunnyVideo> {
  return bunnyRequest<BunnyVideo>(env, "GET", `/videos/${encodeURIComponent(videoId)}`);
}

export async function getBunnyResolutions(env: Env, videoId: string): Promise<BunnyResolutionsInfo> {
  return bunnyRequest<BunnyResolutionsInfo>(
    env,
    "GET",
    `/videos/${encodeURIComponent(videoId)}/resolutions`,
  );
}

export async function deleteBunnyVideo(env: Env, videoId: string): Promise<void> {
  if (!bunnyConfigured(env) || !videoId.trim()) return;
  try {
    await bunnyRequest(env, "DELETE", `/videos/${encodeURIComponent(videoId)}`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    // Already gone is fine during reconcile/delete races.
    if (!/404|not found/i.test(message)) throw caught;
  }
}

export function parseMp4Heights(
  info: BunnyResolutionsInfo,
  fallbackAvailable?: string | string[] | null,
): number[] {
  const heights = new Set<number>();
  const addRaw = (raw: unknown) => {
    const matches = String(raw ?? "").match(/\d{3,4}/g);
    if (!matches) return;
    for (const match of matches) {
      const value = Number(match);
      if (Number.isFinite(value) && value >= 144) heights.add(value);
    }
  };

  for (const item of info.mp4Resolutions ?? []) {
    const fromHeight = Number(item.height);
    if (Number.isFinite(fromHeight) && fromHeight > 0) {
      heights.add(Math.round(fromHeight));
      continue;
    }
    addRaw(item.resolution ?? item.path ?? "");
  }

  const available = info.availableResolutions ?? fallbackAvailable ?? null;
  if (typeof available === "string") {
    addRaw(available);
  } else if (Array.isArray(available)) {
    for (const raw of available) addRaw(raw);
  }

  return [...heights].sort((a, b) => b - a);
}

/** Product rule: require 1080 when source ≥ 1080; else max available ≤ source height. No upscale. */
export function pickDownloadResolution(
  sourceHeight: number | null | undefined,
  mp4Heights: number[],
): { ok: true; resolution: number } | { ok: false; error: string } {
  const height = Number(sourceHeight ?? 0);
  if (!mp4Heights.length) {
    return { ok: false, error: "unavailable_mp4_resolution" };
  }
  if (Number.isFinite(height) && height >= 1080) {
    if (!mp4Heights.includes(1080)) {
      return { ok: false, error: "unavailable_mp4_resolution" };
    }
    return { ok: true, resolution: 1080 };
  }
  const ceiling = Number.isFinite(height) && height > 0 ? height : Math.max(...mp4Heights);
  const candidates = mp4Heights.filter((value) => value <= ceiling);
  if (!candidates.length) {
    return { ok: false, error: "unavailable_mp4_resolution" };
  }
  return { ok: true, resolution: Math.max(...candidates) };
}

export function bunnyClipTitle(clipId: string): string {
  return `replayr:${clipId}`;
}

export function parseClipIdFromBunnyTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = title.trim().match(/^replayr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bunnyMp4Url(
  env: Env,
  videoId: string,
  resolution: number,
  expiresInSeconds = 900,
): Promise<string> {
  const { cdnHostname } = requireBunnyConfig(env);
  const host = cdnHostname.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const path = `/${videoId}/play_${resolution}p.mp4`;
  const tokenKey = env.BUNNY_STREAM_TOKEN_AUTH_KEY?.trim();
  if (!tokenKey) {
    return `https://${host}${path}`;
  }
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, expiresInSeconds);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tokenKey}${path}${expires}`),
  );
  const token = toHex(digest);
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

/** Fetch play_Np.mp4 from CDN with an allowed Referer (pull zone blocks bare GETs with 403 HTML). */
export async function fetchBunnyMp4(
  env: Env,
  videoId: string,
  resolution: number,
): Promise<Response> {
  const url = await bunnyMp4Url(env, videoId, resolution);
  return fetch(url, {
    headers: {
      Referer: "https://www.replayr.tv/",
      Origin: "https://www.replayr.tv",
    },
  });
}

export async function verifyBunnyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  readonlyApiKey: string,
): Promise<boolean> {
  if (!signatureHeader || !readonlyApiKey) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(readonlyApiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = toHex(signed);
  const provided = signatureHeader.trim().toLowerCase();
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
