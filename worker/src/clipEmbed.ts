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
/** Discord's media proxy will not inline a larger MP4. Bigger clips still get a title and poster. */
const DISCORD_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

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
  bytes: number | null;
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
  const bytes = Number(input.bytes);
  const playable = input.found && (!Number.isFinite(bytes) || bytes <= 0 || bytes <= DISCORD_VIDEO_MAX_BYTES);
  const tags = [
    `<title>${escapeAttr(title)}</title>`,
    `<meta name="robots" content="noindex" />`,
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<meta property="og:site_name" content="Replayr" />`,
    `<meta property="og:type" content="${playable ? "video.other" : "website"}" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
  ];
  if (!input.found) return tags.join("");
  const videoUrl = `${origin}${clipVideoPath(input.slug)}`;
  if (!playable && !input.hasPoster) return tags.join("");
  const width = frameSize(input.width);
  const height = frameSize(input.height);
  if (playable) {
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
  } else {
    tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
  }
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
  const payload = await posterPayload(new Uint8Array(await upstream.arrayBuffer()));
  if (!payload) return new Response(null, { status: 404 });
  return embedResponse(request, 200, payload.contentType, payload.body, upstream);
}

/** JPEG/PNG/WebP pass through. Desktop thumbs are 32-bit BMP, which Discord will not render, so those become JPEG. */
export async function posterPayload(bytes: Uint8Array): Promise<{ contentType: string; body: Uint8Array } | null> {
  const sniffed = imageContentType(bytes);
  if (sniffed) return { contentType: sniffed, body: bytes };
  const frame = bmpToRgba(bytes);
  if (!frame) return null;
  return { contentType: "image/png", body: await rgbaToPng(frame.width, frame.height, frame.data) };
}

async function rgbaToPng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (1 + width * 4);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dest + 1);
  }
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())];
  const size = signature.length + chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  png.set(signature, 0);
  let offset = signature.length;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
