const BLOCKED_EXT = new Set(["exe", "msi", "bat", "cmd", "ps1", "scr", "dll", "js", "com", "vbs", "wsf"]);

const IMAGE_MAX = 10 * 1024 * 1024;
const PDF_MAX = 25 * 1024 * 1024;
const TEXT_MAX = 2 * 1024 * 1024;

const ALLOWED: Record<string, { ext: string[]; maxBytes: number }> = {
  "image/jpeg": { ext: ["jpg", "jpeg"], maxBytes: IMAGE_MAX },
  "image/png": { ext: ["png"], maxBytes: IMAGE_MAX },
  "image/webp": { ext: ["webp"], maxBytes: IMAGE_MAX },
  "application/pdf": { ext: ["pdf"], maxBytes: PDF_MAX },
  "text/plain": { ext: ["txt", "log"], maxBytes: TEXT_MAX },
};

export type AllowedAttachment = {
  mime: string;
  filename: string;
  ext: string;
  maxBytes: number;
};

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match?.[1] ?? "";
}

export function sanitizeAttachmentFilename(raw: string): string {
  return raw.replace(/[^\w.\- ()]/g, "").replace(/^\.+/, "").slice(0, 120);
}

export function assertAllowedAttachment(input: {
  filename: string;
  mime: string;
  bytes: number;
}): AllowedAttachment {
  const filename = sanitizeAttachmentFilename(input.filename);
  if (!filename) throw new Error("Filename is required.");
  const ext = extensionOf(filename);
  if (!ext || BLOCKED_EXT.has(ext)) throw new Error("That file type is not allowed.");
  const mime = input.mime.toLowerCase().split(";")[0]!.trim();
  const rule = ALLOWED[mime];
  if (!rule || !rule.ext.includes(ext)) throw new Error("File type and extension do not match.");
  if (!Number.isFinite(input.bytes) || input.bytes <= 0 || input.bytes > rule.maxBytes) {
    throw new Error(`File must be between 1 byte and ${Math.round(rule.maxBytes / (1024 * 1024))} MB.`);
  }
  return { mime, filename, ext, maxBytes: rule.maxBytes };
}

export function isImageMime(mime: string | null | undefined): boolean {
  return Boolean(mime && mime.startsWith("image/") && ALLOWED[mime]);
}

export function isPdfMime(mime: string | null | undefined): boolean {
  return mime === "application/pdf";
}

export function avatarKey(userId: string, objectId: string, ext: "jpg" | "jpeg" | "png" | "webp"): string {
  return `avatars/${userId}/${objectId}.${ext === "jpeg" ? "jpg" : ext}`;
}

export function isOwnedAvatarKey(userId: string, key: string | null | undefined): key is string {
  return Boolean(
    key &&
      !key.includes("..") &&
      key.startsWith(`avatars/${userId}/`) &&
      /^avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(key),
  );
}

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIMES: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function sniffAvatarMime(bytes: ArrayBuffer): "image/jpeg" | "image/png" | "image/webp" | null {
  const view = new Uint8Array(bytes);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg";
  if (
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    view.length >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x45 &&
    view[10] === 0x42 &&
    view[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
