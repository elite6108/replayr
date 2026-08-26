import type { Env } from "./env";
import { HttpError, json } from "./http";
import { objectUrl, r2Client, serviceRest } from "./shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEMENTS = new Set(["banner", "modal"]);
const AUDIENCES = new Set(["all", "signed_out", "signed_in", "free", "premium"]);
const FREQUENCIES = new Set(["once", "every_session", "interval"]);
const DISMISS = new Set(["forever", "snooze"]);
const SURFACES = new Set(["desktop", "web", "mobile"]);
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SELECT =
  "id,enabled,title,body,image_url,image_key,cta_label,cta_url,placement,show_desktop,show_web,show_mobile,audience,starts_at,ends_at,frequency,interval_hours,max_impressions,dismiss_behavior,dismissible,priority,content_revision,created_at,updated_at";

interface AnnouncementRow {
  id: string;
  enabled: boolean;
  title: string;
  body: string | null;
  image_url: string | null;
  image_key: string | null;
  cta_label: string | null;
  cta_url: string | null;
  placement: "banner" | "modal";
  show_desktop: boolean;
  show_web: boolean;
  show_mobile: boolean;
  audience: "all" | "signed_out" | "signed_in" | "free" | "premium";
  starts_at: string;
  ends_at: string | null;
  frequency: "once" | "every_session" | "interval";
  interval_hours: number;
  max_impressions: number | null;
  dismiss_behavior: "forever" | "snooze";
  dismissible: boolean;
  priority: number;
  content_revision: number;
  created_at?: string;
  updated_at?: string;
}

export async function handlePublicAnnouncements(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/v1/announcements") {
    return listPublic(env, url.searchParams.get("surface"));
  }
  return null;
}

export async function handleAdminAnnouncements(
  request: Request,
  env: Env,
  url: URL,
  actor: { id: string; serviceKey: string },
): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/admin/announcements") {
    return listAdmin(env);
  }
  if (request.method === "POST" && path === "/v1/admin/announcements") {
    return createAnnouncement(request, env, actor.id);
  }
  const image = path.match(/^\/v1\/admin\/announcements\/([^/]+)\/image$/);
  if (request.method === "POST" && image?.[1]) {
    return uploadImage(request, env, image[1]);
  }
  const item = path.match(/^\/v1\/admin\/announcements\/([^/]+)$/);
  if (!item?.[1]) return null;
  if (request.method === "PATCH") return patchAnnouncement(request, env, item[1]);
  if (request.method === "DELETE") return deleteAnnouncement(env, item[1]);
  return null;
}

async function listPublic(env: Env, surfaceRaw: string | null): Promise<Response> {
  const surface = (surfaceRaw || "").toLowerCase();
  if (!SURFACES.has(surface)) {
    return json({ error: "surface must be desktop, web, or mobile." }, 400);
  }
  const now = encodeURIComponent(new Date().toISOString());
  const flag = surface === "desktop" ? "show_desktop" : surface === "mobile" ? "show_mobile" : "show_web";
  const rows = await serviceRest<AnnouncementRow[]>(
    env,
    "GET",
    `/announcements?enabled=eq.true&${flag}=eq.true&starts_at=lte.${now}&or=(ends_at.is.null,ends_at.gte.${now})&select=${SELECT}&order=priority.desc,starts_at.desc&limit=20`,
  );
  const announcements = [];
  for (const row of rows) {
    announcements.push(await presentPublic(env, row));
  }
  return json({ announcements });
}

async function listAdmin(env: Env): Promise<Response> {
  const rows = await serviceRest<AnnouncementRow[]>(
    env,
    "GET",
    `/announcements?select=${SELECT}&order=updated_at.desc&limit=100`,
  );
  const announcements = [];
  for (const row of rows) announcements.push(await presentAdmin(env, row));
  return json({ announcements });
}

async function createAnnouncement(request: Request, env: Env, actorId: string): Promise<Response> {
  const patch = parseWriteBody(await request.json().catch(() => ({})));
  if (!patch.title) return json({ error: "Title is required." }, 400);
  const row = {
    ...defaults(),
    ...patch,
    created_by: actorId,
    updated_at: new Date().toISOString(),
  };
  assertSchedule(String(row.starts_at), (row.ends_at as string | null) ?? null);
  const created = await serviceRest<AnnouncementRow[]>(env, "POST", "/announcements", row, "return=representation");
  const item = created[0];
  if (!item) return json({ error: "Could not create that announcement." }, 502);
  return json({ announcement: await presentAdmin(env, item) }, 201);
}

async function patchAnnouncement(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "Announcement id is invalid." }, 400);
  const existing = await loadOne(env, id);
  if (!existing) return json({ error: "That announcement was not found." }, 404);
  const patch = parseWriteBody(await request.json().catch(() => ({})));
  assertSchedule(
    typeof patch.starts_at === "string" ? patch.starts_at : existing.starts_at,
    patch.ends_at === undefined ? existing.ends_at : (patch.ends_at as string | null),
  );
  const contentChanged = contentFieldsChanged(existing, patch);
  const updated = await serviceRest<AnnouncementRow[]>(
    env,
    "PATCH",
    `/announcements?id=eq.${id}`,
    {
      ...patch,
      ...(contentChanged ? { content_revision: existing.content_revision + 1 } : {}),
      updated_at: new Date().toISOString(),
    },
    "return=representation",
  );
  const item = updated[0] ?? { ...existing, ...patch };
  return json({ announcement: await presentAdmin(env, item) });
}

async function deleteAnnouncement(env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "Announcement id is invalid." }, 400);
  const existing = await loadOne(env, id);
  if (!existing) return json({ error: "That announcement was not found." }, 404);
  if (existing.image_key) await deleteImageObject(env, existing.image_key);
  await serviceRest(env, "DELETE", `/announcements?id=eq.${id}`);
  return json({ ok: true });
}

async function uploadImage(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "Announcement id is invalid." }, 400);
  const existing = await loadOne(env, id);
  if (!existing) return json({ error: "That announcement was not found." }, 404);
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) return json({ error: "Upload a PNG, JPEG, WebP, or GIF." }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_IMAGE_BYTES) {
    return json({ error: "Image must be between 32 bytes and 2 MB." }, 400);
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
    throw new HttpError(503, "Cloud storage is not configured on the Worker.");
  }
  const key = `announcements/${id}/image.${ext}`;
  const put = await r2Client(env).fetch(objectUrl(env, key), {
    method: "PUT",
    headers: { "content-type": type },
    body: bytes,
  });
  if (!put.ok) {
    return json({ error: `Could not store that image: ${await put.text()}` }, 502);
  }
  if (existing.image_key && existing.image_key !== key) await deleteImageObject(env, existing.image_key);
  const updated = await serviceRest<AnnouncementRow[]>(
    env,
    "PATCH",
    `/announcements?id=eq.${id}`,
    {
      image_key: key,
      content_revision: existing.content_revision + 1,
      updated_at: new Date().toISOString(),
    },
    "return=representation",
  );
  return json({ announcement: await presentAdmin(env, updated[0] ?? { ...existing, image_key: key }) });
}

async function loadOne(env: Env, id: string): Promise<AnnouncementRow | null> {
  const rows = await serviceRest<AnnouncementRow[]>(env, "GET", `/announcements?id=eq.${id}&select=${SELECT}`);
  return rows[0] ?? null;
}

function defaults() {
  return {
    enabled: false,
    body: null as string | null,
    image_url: null as string | null,
    image_key: null as string | null,
    cta_label: null as string | null,
    cta_url: null as string | null,
    placement: "modal",
    show_desktop: true,
    show_web: true,
    show_mobile: true,
    audience: "all",
    starts_at: new Date().toISOString(),
    ends_at: null as string | null,
    frequency: "once",
    interval_hours: 24,
    max_impressions: null as number | null,
    dismiss_behavior: "forever",
    dismissible: true,
    priority: 0,
    content_revision: 1,
  };
}

function parseWriteBody(raw: unknown): Record<string, unknown> {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") out.enabled = body.enabled;
  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (title.length < 1 || title.length > 120) throw new HttpError(400, "Title must be 1–120 characters.");
    out.title = title;
  }
  if (body.body === null) out.body = null;
  else if (typeof body.body === "string") {
    const text = body.body.trim();
    if (text.length > 2000) throw new HttpError(400, "Body must be 2000 characters or less.");
    out.body = text || null;
  }
  if (body.imageUrl === null || body.image_url === null) {
    out.image_url = null;
  } else if (typeof body.imageUrl === "string" || typeof body.image_url === "string") {
    out.image_url = sanitizeHttpUrl(String(body.imageUrl ?? body.image_url), "Image URL") || null;
  }
  if (body.ctaLabel === null || body.cta_label === null) out.cta_label = null;
  else if (typeof body.ctaLabel === "string" || typeof body.cta_label === "string") {
    const label = String(body.ctaLabel ?? body.cta_label).trim();
    if (label.length > 40) throw new HttpError(400, "Button label must be 40 characters or less.");
    out.cta_label = label || null;
  }
  if (body.ctaUrl === null || body.cta_url === null) out.cta_url = null;
  else if (typeof body.ctaUrl === "string" || typeof body.cta_url === "string") {
    out.cta_url = sanitizeCtaUrl(String(body.ctaUrl ?? body.cta_url));
  }
  if (typeof body.placement === "string") {
    if (!PLACEMENTS.has(body.placement)) throw new HttpError(400, "Placement must be banner or modal.");
    out.placement = body.placement;
  }
  if (typeof body.showDesktop === "boolean") out.show_desktop = body.showDesktop;
  if (typeof body.show_desktop === "boolean") out.show_desktop = body.show_desktop;
  if (typeof body.showWeb === "boolean") out.show_web = body.showWeb;
  if (typeof body.show_web === "boolean") out.show_web = body.show_web;
  if (typeof body.showMobile === "boolean") out.show_mobile = body.showMobile;
  if (typeof body.show_mobile === "boolean") out.show_mobile = body.show_mobile;
  if (typeof body.audience === "string") {
    if (!AUDIENCES.has(body.audience)) throw new HttpError(400, "Audience is invalid.");
    out.audience = body.audience;
  }
  if (typeof body.startsAt === "string" || typeof body.starts_at === "string") {
    out.starts_at = parseTime(String(body.startsAt ?? body.starts_at), "Start date");
  }
  if (body.endsAt === null || body.ends_at === null) out.ends_at = null;
  else if (typeof body.endsAt === "string" || typeof body.ends_at === "string") {
    const value = String(body.endsAt ?? body.ends_at).trim();
    out.ends_at = value ? parseTime(value, "End date") : null;
  }
  if (typeof body.frequency === "string") {
    if (!FREQUENCIES.has(body.frequency)) throw new HttpError(400, "Frequency is invalid.");
    out.frequency = body.frequency;
  }
  if (typeof body.intervalHours === "number" || typeof body.interval_hours === "number") {
    const hours = Math.floor(Number(body.intervalHours ?? body.interval_hours));
    if (hours < 1 || hours > 24 * 30) throw new HttpError(400, "Repeat interval must be 1–720 hours.");
    out.interval_hours = hours;
  }
  if (body.maxImpressions === null || body.max_impressions === null) out.max_impressions = null;
  else if (typeof body.maxImpressions === "number" || typeof body.max_impressions === "number") {
    const max = Math.floor(Number(body.maxImpressions ?? body.max_impressions));
    if (max < 1 || max > 100) throw new HttpError(400, "Max times shown must be 1–100.");
    out.max_impressions = max;
  }
  if (typeof body.dismissBehavior === "string" || typeof body.dismiss_behavior === "string") {
    const value = String(body.dismissBehavior ?? body.dismiss_behavior);
    if (!DISMISS.has(value)) throw new HttpError(400, "Dismiss behavior is invalid.");
    out.dismiss_behavior = value;
  }
  if (typeof body.dismissible === "boolean") out.dismissible = body.dismissible;
  if (typeof body.priority === "number") {
    const priority = Math.floor(body.priority);
    if (priority < -100 || priority > 100) throw new HttpError(400, "Priority must be between -100 and 100.");
    out.priority = priority;
  }
  return out;
}

function contentFieldsChanged(existing: AnnouncementRow, patch: Record<string, unknown>) {
  const keys = ["title", "body", "image_url", "cta_label", "cta_url", "placement"];
  return keys.some((key) => key in patch && patch[key] !== existing[key as keyof AnnouncementRow]);
}

function sanitizeHttpUrl(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, `${label} must be a valid https URL.`);
  }
  if (parsed.protocol !== "https:") throw new HttpError(400, `${label} must be https.`);
  return parsed.toString();
}

function sanitizeCtaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    if (trimmed.length > 300) throw new HttpError(400, "Link is too long.");
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, "Link must be https or a site path like /pricing.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "Link must be https or a site path like /pricing.");
  }
  return parsed.toString();
}

function parseTime(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} is invalid.`);
  return date.toISOString();
}

function assertSchedule(startsAt: string, endsAt: string | null) {
  if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new HttpError(400, "End date must be after the start date.");
  }
}

async function presentPublic(env: Env, row: AnnouncementRow) {
  return {
    id: row.id,
    revision: row.content_revision,
    title: row.title,
    body: row.body,
    imageUrl: (await signedImageUrl(env, row.image_key)) || row.image_url,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    placement: row.placement,
    audience: row.audience,
    frequency: row.frequency,
    intervalHours: row.interval_hours,
    maxImpressions: row.max_impressions,
    dismissBehavior: row.dismiss_behavior,
    dismissible: row.dismissible !== false,
    priority: row.priority,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

async function presentAdmin(env: Env, row: AnnouncementRow) {
  return {
    ...(await presentPublic(env, row)),
    enabled: row.enabled,
    imageUrl: row.image_url,
    uploadedImageUrl: await signedImageUrl(env, row.image_key),
    showDesktop: row.show_desktop,
    showWeb: row.show_web,
    showMobile: row.show_mobile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isAnnouncementImageKey(key: string | null | undefined): key is string {
  return Boolean(key && /^announcements\/[0-9a-f-]{36}\/image\.(png|jpg|webp|gif)$/i.test(key) && !key.includes(".."));
}

async function signedImageUrl(env: Env, key: string | null | undefined): Promise<string | null> {
  if (!isAnnouncementImageKey(key)) return null;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) return null;
  const signed = await r2Client(env).sign(`${objectUrl(env, key)}?X-Amz-Expires=3600`, {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

async function deleteImageObject(env: Env, key: string) {
  if (!isAnnouncementImageKey(key)) return;
  try {
    await r2Client(env).fetch(objectUrl(env, key), { method: "DELETE" });
  } catch {
    /* best-effort */
  }
}
