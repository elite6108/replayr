import { fetchBillingStatus } from "./api";
import { readApiJson } from "./http";
import { sessionStorage } from "./sessionStorage";
import { apiUrl } from "./supabase";

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
const sessionShown = new Set<string>();
let memory: Record<string, SeenRecord> = {};
let loaded = false;

export async function fetchActiveAnnouncements(accessToken?: string | null): Promise<Announcement[]> {
  const headers: HeadersInit = { accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(apiUrl("/v1/announcements?surface=mobile"), { headers });
  const body = await readApiJson<{ announcements?: Announcement[] }>(response, "Could not load announcements.");
  return body.announcements ?? [];
}

export async function pickAnnouncement(
  items: Announcement[],
  viewer: AnnouncementViewer,
  now = Date.now(),
): Promise<Announcement | null> {
  await ensureStore();
  let best: Announcement | null = null;
  for (const item of items) {
    if (!isEligible(item, viewer, now, memory[item.id], sessionShown.has(`${item.id}:${item.revision}`))) continue;
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

export async function markAnnouncementShown(item: Announcement) {
  await ensureStore();
  const prev = matching(memory[item.id], item.revision);
  memory[item.id] = {
    revision: item.revision,
    shownCount: (prev?.shownCount ?? 0) + 1,
    lastShownAt: Date.now(),
    dismissedAt: prev?.dismissedAt ?? null,
  };
  sessionShown.add(`${item.id}:${item.revision}`);
  await persist();
}

export async function markAnnouncementDismissed(item: Announcement) {
  await ensureStore();
  const prev = matching(memory[item.id], item.revision);
  memory[item.id] = {
    revision: item.revision,
    shownCount: prev?.shownCount ?? 1,
    lastShownAt: prev?.lastShownAt ?? Date.now(),
    dismissedAt: Date.now(),
  };
  await persist();
}

export async function loadViewerPremium(accessToken?: string | null): Promise<boolean | null> {
  if (!accessToken) return null;
  try {
    const status = await fetchBillingStatus(accessToken);
    return Boolean(status.premium);
  } catch {
    return null;
  }
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

async function ensureStore() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, SeenRecord>) : {};
    memory = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    memory = {};
  }
}

async function persist() {
  try {
    await sessionStorage.setItem(STORE_KEY, JSON.stringify(memory));
  } catch {
    /* ignore */
  }
}
