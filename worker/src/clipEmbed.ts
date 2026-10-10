import { encode as encodeJpeg } from "jpeg-js";
import { HttpError } from "./http";
import { assertRateLimit } from "./rateLimit";
import {
  lookupPlaybackRaw,
  objectUrl,
  ownedObjectKey,
  r2Client,
  requireR2,
  type Env,
  type PlaybackRow,
} from "./shared";

const TITLE_MAX = 80;

export function clipVideoPath(slug: string): string {
  return `/c/${slug}/video.mp4`;
}

export function clipPosterPath(slug: string): string {
  return `/c/${slug}/poster`;
}

/** User titles are embed text, never HTML. Control characters and markup cannot break out of the attribute. */
export function clipEmbedTitle(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
  return `${cleaned || "Clip"} · Replayr`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function frameSize(value: number | null | undefined): number | null {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next < 2 || next > 7680) return null;
  return next;
}

export type ClipOgInput = {
  origin: string;
  slug: string;
  title: string | null;
  width: number | null;
  height: number | null;
  hasPoster: boolean;
  found: boolean;
};

/**
 * Open Graph for Discord. Tags are fixed except the escaped clip title.
 * Video and poster point at our own paths so the crawler never sees an R2 signature.
 */
export function clipHeadTags(input: ClipOgInput): string {
  const origin = input.origin.replace(/\/$/, "");
  const pageUrl = `${origin}/c/${input.slug}`;
  const title = clipEmbedTitle(input.found ? input.title : null);
  const description = input.found ? "Watch on Replayr." : "This clip is no longer available.";
  const tags = [
    `<title>${escapeAttr(title)}</title>`,
    `<meta name="robots" content="noindex" />`,
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<meta property="og:site_name" content="Replayr" />`,
    `<meta property="og:type" content="${input.found ? "video.other" : "website"}" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
  ];
  if (!input.found) return tags.join("");
  const videoUrl = `${origin}${clipVideoPath(input.slug)}`;
  const width = frameSize(input.width);
  const height = frameSize(input.height);
  tags.push(`<meta property="og:video" content="${escapeAttr(videoUrl)}" />`);
  tags.push(`<meta property="og:video:url" content="${escapeAttr(videoUrl)}" />`);
  tags.push(`<meta property="og:video:secure_url" content="${escapeAttr(videoUrl)}" />`);
  tags.push(`<meta property="og:video:type" content="video/mp4" />`);
  if (width) tags.push(`<meta property="og:video:width" content="${width}" />`);
  if (height) tags.push(`<meta property="og:video:height" content="${height}" />`);
  tags.push(`<meta name="twitter:card" content="player" />`);
  tags.push(`<meta name="twitter:player:stream" content="${escapeAttr(videoUrl)}" />`);
  tags.push(`<meta name="twitter:player:stream:content_type" content="video/mp4" />`);
  if (width) tags.push(`<meta name="twitter:player:width" content="${width}" />`);
  if (height) tags.push(`<meta name="twitter:player:height" content="${height}" />`);
  if (input.hasPoster) {
    const imageUrl = `${origin}${clipPosterPath(input.slug)}`;
    tags.push(`<meta property="og:image" content="${escapeAttr(imageUrl)}" />`);
    tags.push(`<meta property="og:image:secure_url" content="${escapeAttr(imageUrl)}" />`);
    if (width) tags.push(`<meta property="og:image:width" content="${width}" />`);
    if (height) tags.push(`<meta property="og:image:height" content="${height}" />`);
    tags.push(`<meta name="twitter:image" content="${escapeAttr(imageUrl)}" />`);
  }
  return tags.join("");
}

/** Public and unlisted links unfurl. Private clips stay invisible to crawlers. */
export async function lookupShareClip(env: Env, slug: string): Promise<PlaybackRow | null> {
  const clip = await lookupPlaybackRaw(env, slug);
  if (!clip) return null;
  if (clip.visibility !== "public" && clip.visibility !== "unlisted") return null;
  return clip;
}

const RANGE = /^bytes=(\d+)-(\d*)$/;

function imageContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function serveClipEmbedAsset(
  request: Request,
  env: Env,
  slug: string,
  kind: "video" | "poster",
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  requireR2(env);
  const clip = await lookupShareClip(env, slug);
  const key = clip ? (kind === "video" ? clip.storage_key : clip.thumbnail_key) : null;
  if (!clip || !ownedObjectKey(clip.user_id, key)) {
    try {
      assertRateLimit(request, "clip-embed-miss", 30);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 429) {
        return new Response(null, { status: 429 });
      }
      throw caught;
    }
    return new Response(null, { status: 404 });
  }

  if (kind === "poster") return servePoster(request, env, key);
  return serveVideo(request, env, key);
}

async function servePoster(request: Request, env: Env, key: string): Promise<Response> {
  const signed = await r2Client(env).sign(`${objectUrl(env, key)}?X-Amz-Expires=120`, {
    method: "GET",
    aws: { signQuery: true },
  });
  const upstream = await fetch(signed.url, { method: "GET" });
  if (!upstream.ok || !upstream.body) return new Response(null, { status: 404 });
  const payload = posterPayload(new Uint8Array(await upstream.arrayBuffer()));
  if (!payload) return new Response(null, { status: 404 });
  return embedResponse(request, 200, payload.contentType, payload.body, upstream);
}

/** JPEG/PNG/WebP pass through. Desktop thumbs are 32-bit BMP, which Discord will not render, so those become JPEG. */
export function posterPayload(bytes: Uint8Array): { contentType: string; body: Uint8Array } | null {
  const sniffed = imageContentType(bytes);
  if (sniffed) return { contentType: sniffed, body: bytes };
  const frame = bmpToRgba(bytes);
  if (!frame) return null;
  const jpeg = encodeJpeg({ data: frame.data, width: frame.width, height: frame.height }, 80);
  return { contentType: "image/jpeg", body: new Uint8Array(jpeg.data) };
}

function bmpToRgba(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const planes = view.getUint16(26, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (planes !== 1 || compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;
  if (width < 1 || width > 1920) return null;
  const height = Math.abs(heightRaw);
  if (height < 1 || height > 1080 || width * height > 1920 * 1080) return null;
  const bytesPerPixel = bpp / 8;
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (pixelOffset + rowStride * height > bytes.length) return null;
  const rgba = new Uint8Array(width * height * 4);
  const bottomUp = heightRaw > 0;
  for (let y = 0; y < height; y += 1) {
    const srcY = bottomUp ? height - 1 - y : y;
    const src = pixelOffset + srcY * rowStride;
    for (let x = 0; x < width; x += 1) {
      const s = src + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      rgba[d] = bytes[s + 2] ?? 0;
      rgba[d + 1] = bytes[s + 1] ?? 0;
      rgba[d + 2] = bytes[s] ?? 0;
      rgba[d + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

async function serveVideo(request: Request, env: Env, key: string): Promise<Response> {
  const rangeHeader = request.headers.get("range");
  const range = request.method === "GET" && rangeHeader && RANGE.test(rangeHeader) ? rangeHeader : null;
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const signed = await r2Client(env).sign(`${objectUrl(env, key)}?X-Amz-Expires=120`, {
    method,
    aws: { signQuery: true },
  });
  const upstream = await fetch(signed.url, {
    method,
    headers: range ? { range } : undefined,
  });
  if (!upstream.ok && upstream.status !== 206) return new Response(null, { status: 404 });
  return embedResponse(request, upstream.status, "video/mp4", null, upstream);
}

function embedResponse(
  request: Request,
  status: number,
  contentType: string,
  poster: Uint8Array | null,
  upstream: Response,
): Response {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("content-disposition", "inline");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex");
  headers.set("cache-control", "public, max-age=300");
  headers.set("accept-ranges", "bytes");
  const length = poster ? String(poster.byteLength) : upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange && status === 206) headers.set("content-range", contentRange);
  const body = request.method === "HEAD" ? null : poster ?? upstream.body;
  return new Response(body, { status: status === 206 ? 206 : 200, headers });
}
