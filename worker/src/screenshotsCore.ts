/**
 * Pure screenshot helpers. Vitest runs in Node, which has no HTMLRewriter or FixedLengthStream,
 * so Worker streaming and HTML rewriting stay behind adapters in screenshots.ts.
 */

export const SCREENSHOT_SLUG = /^[a-km-z2-9]{12}$/;
export const SCREENSHOT_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
export const MIN_SCREENSHOT_BYTES = 67;
export const MAX_SIDE_PX = 16384;
export const MAX_PIXELS = 50_000_000;
export const PNG_HEADER_BYTES = 33;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngHeader = { width: number; height: number };

export type ScreenshotRpcErrorCode = "screenshot_busy" | "screenshot_too_large" | "screenshot_not_png";

export class ScreenshotParseError extends Error {
  code: ScreenshotRpcErrorCode;
  constructor(code: ScreenshotRpcErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reject bytes that would wrap the alphabet so slug generation has no modulo bias. */
export function randomScreenshotSlug(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  const alphabet = SCREENSHOT_ALPHABET;
  const max = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 12) {
    const bytes = randomBytes(16);
    for (const value of bytes) {
      if (value >= max) continue;
      out += alphabet[value % alphabet.length];
      if (out.length === 12) break;
    }
  }
  return out;
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function isScreenshotSlug(value: string): boolean {
  return SCREENSHOT_SLUG.test(value);
}

/**
 * Screenshots live at screenshots/{user}/{id}.png. Do not widen ownedObjectKey — that pattern is
 * clips/{user}/{clip}/original.mp4 and must stay that way so a screenshot key can never be treated
 * as a clip object (or the reverse).
 */
export function ownedScreenshotKey(userId: string, key: string | null | undefined): key is string {
  if (!key || key.includes("..") || key.includes("\\")) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return false;
  return new RegExp(
    `^screenshots/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`,
    "i",
  ).test(key);
}

export function parsePngHeader(bytes: Uint8Array): PngHeader {
  if (bytes.byteLength < PNG_HEADER_BYTES) {
    throw new ScreenshotParseError("screenshot_not_png", "That file is not a PNG.");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new ScreenshotParseError("screenshot_not_png", "That file is not a PNG.");
    }
  }
  const length = (bytes[8]! << 24) | (bytes[9]! << 16) | (bytes[10]! << 8) | bytes[11]!;
  const ihdr = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) === "IHDR";
  if (length !== 13 || !ihdr) {
    throw new ScreenshotParseError("screenshot_not_png", "That file is not a PNG.");
  }
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  if (width < 1 || height < 1 || width > MAX_SIDE_PX || height > MAX_SIDE_PX || width * height > MAX_PIXELS) {
    throw new ScreenshotParseError("screenshot_too_large", "That screenshot is too large.");
  }
  return { width, height };
}

export function screenshotSharePath(slug: string): string {
  return `/s/${slug}`;
}

export function screenshotImagePath(slug: string): string {
  return `/s/${slug}.png`;
}

export type ScreenshotOgInput = {
  origin: string;
  slug: string;
  width?: number;
  height?: number;
  found: boolean;
};

/**
 * Server-rendered OG tags for Discord/Slack/iMessage. No user text — titles are fixed so a
 * screenshot caption cannot become an XSS or spoofed embed.
 */
export function screenshotHeadTags(input: ScreenshotOgInput): string {
  const pageUrl = `${input.origin}${screenshotSharePath(input.slug)}`;
  const description = input.found ? "A Replayr screenshot." : "This screenshot is no longer available.";
  const tags = [
    `<title>Screenshot \u00b7 Replayr</title>`,
    `<meta name="robots" content="noindex" />`,
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Replayr" />`,
    `<meta property="og:title" content="Screenshot \u00b7 Replayr" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="Screenshot \u00b7 Replayr" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
  ];
  if (input.found) {
    const imageUrl = `${input.origin}${screenshotImagePath(input.slug)}`;
    tags.push(`<meta property="og:image" content="${escapeAttr(imageUrl)}" />`);
    tags.push(`<meta property="og:image:secure_url" content="${escapeAttr(imageUrl)}" />`);
    tags.push(`<meta property="og:image:type" content="image/png" />`);
    if (input.width) tags.push(`<meta property="og:image:width" content="${input.width}" />`);
    if (input.height) tags.push(`<meta property="og:image:height" content="${input.height}" />`);
    tags.push(`<meta name="twitter:image" content="${escapeAttr(imageUrl)}" />`);
  }
  return tags.join("");
}

/** Marketing index.html ships a static title/description that would leak into screenshot embeds. */
export function injectHead(html: string, tags: string): string {
  const stripped = html
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, "")
    .replace(/<title>[^<]*<\/title>\s*/i, "");
  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `${tags}</head>`);
  }
  return `${tags}${stripped}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function mapRpcError(message: string): { status: number; code: string; error: string } | null {
  if (/screenshot_busy/i.test(message)) {
    return { status: 429, code: "screenshot_busy", error: "Wait for an in-flight screenshot to finish." };
  }
  if (/screenshot_too_large/i.test(message)) {
    return { status: 413, code: "screenshot_too_large", error: "That screenshot is too large." };
  }
  return null;
}

export type ScreenshotStreamAdapter = {
  wrapFixedLength: (length: number, body: ReadableStream<Uint8Array>) => BodyInit;
};

/** Identity adapter for Node tests. Production uses FixedLengthStream so R2 sees Content-Length. */
export const passthroughStreamAdapter: ScreenshotStreamAdapter = {
  wrapFixedLength(_length, body) {
    return body;
  },
};

export function productionStreamAdapter(): ScreenshotStreamAdapter {
  return {
    wrapFixedLength(length, body) {
      const Fixed = (
        globalThis as unknown as {
          FixedLengthStream?: new (n: number) => { readable: ReadableStream; writable: WritableStream };
        }
      ).FixedLengthStream;
      if (typeof Fixed !== "function") return body;
      const { readable, writable } = new Fixed(length);
      void body.pipeTo(writable);
      return readable as unknown as BodyInit;
    },
  };
}

export async function prefixThenRest(
  source: ReadableStream<Uint8Array>,
  prefixLength: number,
): Promise<{ prefix: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < prefixLength) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const joined = concat(chunks);
  const prefix = joined.subarray(0, Math.min(prefixLength, joined.byteLength));
  const leftover = joined.byteLength > prefixLength ? joined.subarray(prefixLength) : new Uint8Array();
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.byteLength) controller.enqueue(leftover);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done || !value) {
        controller.close();
        reader.releaseLock();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, rest };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function chainBytes(prefix: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength) controller.enqueue(prefix);
    },
    async pull(controller) {
      reader ??= rest.getReader();
      const { done, value } = await reader.read();
      if (done || !value) {
        controller.close();
        reader.releaseLock();
        reader = null;
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader ? reader.cancel(reason) : rest.cancel(reason);
    },
  });
}
