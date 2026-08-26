import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

export type AnnouncementSurface = "desktop" | "web" | "mobile";
export type AnnouncementPlacement = "banner" | "modal";
export type AnnouncementAudience = "all" | "signed_out" | "signed_in" | "free" | "premium";
export type AnnouncementFrequency = "once" | "every_session" | "interval";
export type AnnouncementDismiss = "forever" | "snooze";

export interface Announcement {
  id: string;
  revision: number;
  title: string;
  body: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  placement: AnnouncementPlacement;
  audience: AnnouncementAudience;
  frequency: AnnouncementFrequency;
  intervalHours: number;
  maxImpressions: number | null;
  dismissBehavior: AnnouncementDismiss;
  dismissible: boolean;
  priority: number;
  startsAt: string;
  endsAt: string | null;
}

export interface AdminAnnouncement extends Announcement {
  enabled: boolean;
  uploadedImageUrl: string | null;
  showDesktop: boolean;
  showWeb: boolean;
  showMobile: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AnnouncementViewer {
  signedIn: boolean;
  premium: boolean | null;
}

interface SeenRecord {
  revision: number;
  shownCount: number;
  lastShownAt: number;
  dismissedAt: number | null;
}

const STORE_KEY = "replayr.announcements.v1";
const SESSION_KEY = "replayr.announcements.session";

export async function fetchActiveAnnouncements(
  surface: AnnouncementSurface,
  accessToken?: string | null,
): Promise<Announcement[]> {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl(`/v1/announcements?surface=${surface}`), { headers });
  const body = await readApiJson<{ announcements?: Announcement[] }>(response, "Could not load announcements.");
  return body.announcements ?? [];
}

export async function fetchAdminAnnouncements(token: string): Promise<AdminAnnouncement[]> {
  const response = await fetch(apiUrl("/v1/admin/announcements"), {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  const body = await readApiJson<{ announcements?: AdminAnnouncement[] }>(response, "Could not load announcements.");
  return body.announcements ?? [];
}

export async function saveAdminAnnouncement(
  token: string,
  payload: Record<string, unknown>,
  id?: string,
): Promise<AdminAnnouncement> {
  const response = await fetch(apiUrl(id ? `/v1/admin/announcements/${id}` : "/v1/admin/announcements"), {
    method: id ? "PATCH" : "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await readApiJson<{ announcement: AdminAnnouncement }>(response, "Could not save that announcement.");
  return body.announcement;
}

export async function deleteAdminAnnouncement(token: string, id: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/admin/announcements/${id}`), {
    method: "DELETE",
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  await readApiJson(response, "Could not delete that announcement.");
}

export async function uploadAnnouncementImage(token: string, id: string, file: Blob): Promise<AdminAnnouncement> {
  const response = await fetch(apiUrl(`/v1/admin/announcements/${id}/image`), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": file.type || "image/png",
    },
    body: file,
  });
  const body = await readApiJson<{ announcement: AdminAnnouncement }>(response, "Could not upload that image.");
  return body.announcement;
}

export function pickAnnouncement(items: Announcement[], viewer: AnnouncementViewer, now = Date.now()): Announcement | null {
  const state = loadStore();
  const session = loadSession();
  let best: Announcement | null = null;
  for (const item of items) {
    if (!isEligible(item, viewer, now, state[item.id], session.has(`${item.id}:${item.revision}`))) continue;
    if (!best || item.priority > best.priority) best = item;
  }
  return best;
}

/** Keep an already-visible announcement until dismiss/expiry, even if frequency rules would hide it. */
export function retainVisibleAnnouncement(
  items: Announcement[],
  current: Announcement | null,
  picked: Announcement | null,
  viewer: AnnouncementViewer,
): Announcement | null {
  if (current) {
    const still = items.find((item) => item.id === current.id && item.revision === current.revision);
    if (still && audienceMatches(still.audience, viewer) && (!picked || picked.id === current.id)) {
      return still;
    }
  }
  return picked;
}

export function markAnnouncementShown(item: Announcement) {
  const state = loadStore();
  const prev = matching(state[item.id], item.revision);
  state[item.id] = {
    revision: item.revision,
    shownCount: (prev?.shownCount ?? 0) + 1,
    lastShownAt: Date.now(),
    dismissedAt: prev?.dismissedAt ?? null,
  };
  saveStore(state);
  const session = loadSession();
  session.add(`${item.id}:${item.revision}`);
  saveSession(session);
}

export function markAnnouncementDismissed(item: Announcement) {
  const state = loadStore();
  const prev = matching(state[item.id], item.revision);
  state[item.id] = {
    revision: item.revision,
    shownCount: prev?.shownCount ?? 1,
    lastShownAt: prev?.lastShownAt ?? Date.now(),
    dismissedAt: Date.now(),
  };
  saveStore(state);
}

function isEligible(
  item: Announcement,
  viewer: AnnouncementViewer,
  now: number,
  raw: SeenRecord | undefined,
  shownThisSession: boolean,
): boolean {
  if (!audienceMatches(item.audience, viewer)) return false;
  const rec = matching(raw, item.revision);
  if (rec?.dismissedAt && item.dismissBehavior === "forever") return false;
  if (item.maxImpressions && (rec?.shownCount ?? 0) >= item.maxImpressions) return false;

  if (item.frequency === "once") {
    if (rec?.dismissedAt && item.dismissBehavior === "snooze") return !shownThisSession;
    return true;
  }
  if (item.frequency === "every_session") {
    if (shownThisSession) return false;
    if (rec?.dismissedAt && item.dismissBehavior === "snooze") return true;
    return !rec?.dismissedAt;
  }
  const last = rec?.dismissedAt && item.dismissBehavior === "snooze" ? rec.dismissedAt : rec?.lastShownAt;
  if (last && now - last < Math.max(1, item.intervalHours) * 60 * 60 * 1000) return false;
  return true;
}

function audienceMatches(audience: AnnouncementAudience, viewer: AnnouncementViewer) {
  if (audience === "all") return true;
  if (audience === "signed_out") return !viewer.signedIn;
  if (audience === "signed_in") return viewer.signedIn;
  if (audience === "free") return viewer.signedIn && viewer.premium === false;
  if (audience === "premium") return viewer.signedIn && viewer.premium === true;
  return false;
}

function matching(record: SeenRecord | undefined, revision: number) {
  if (!record || record.revision !== revision) return undefined;
  return record;
}

function loadStore(): Record<string, SeenRecord> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SeenRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(state: Record<string, SeenRecord>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

function loadSession(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveSession(session: Set<string>) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...session]));
  } catch {
    /* private mode */
  }
}
