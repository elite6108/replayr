import { addUtcDays, utcDay, utcWeekStart, type UtcDay } from "./analyticsDates";

/** Desktop + server qualifying events. First tracked UTC day for true DAU. */
export const ANALYTICS_ACTIVITY_AVAILABLE_FROM: UtcDay = "2026-08-31";
export const ANALYTICS_ACTIVATION_WINDOW_DAYS = 7;
export const ANALYTICS_RETENTION_DAYS = [1, 3, 7, 14, 30, 60, 90] as const;
export const ANALYTICS_ACTIVATION_WINDOWS_HOURS = [1, 24, 72, 168] as const;

export const QUALIFYING_ACTIVE_EVENTS = [
  "app.opened",
  "clip.saved",
  "clip.upload_completed",
  "clip.played",
  "clip.editor_opened",
  "clip.rendered",
  "folder.created",
  "folder.clip_added",
] as const;

export const NON_QUALIFYING_EVENTS = [
  "app.download_clicked",
  "auth.signup_started",
  "auth.signup_completed",
  "capture.started",
  "replay.enabled",
] as const;

export type ActivationSource = "local_clip" | "cloud_clip";
export type ActivationQuality = "exact" | "cloud_proxy";
export type CohortKind = "signup" | "activation";

export type UserActivityDay = {
  day: UtcDay;
  user_id: string;
  environment: string;
  active?: boolean;
};

export type UserMilestone = {
  user_id: string;
  environment: string;
  signup_at: string | null;
  first_app_open_at: string | null;
  first_clip_saved_at: string | null;
  first_cloud_upload_at: string | null;
  activated_at: string | null;
  activation_source: ActivationSource | null;
  activation_quality: ActivationQuality | null;
  last_active_at: string | null;
};

export function isQualifyingActiveEvent(eventName: string): boolean {
  return (QUALIFYING_ACTIVE_EVENTS as readonly string[]).includes(eventName);
}

export function shouldCountTowardDau(input: {
  eventName: string;
  userId?: string | null;
  environment?: string | null;
}): boolean {
  if (!input.userId) return false;
  if (input.environment === "development") return false;
  return isQualifyingActiveEvent(input.eventName);
}

/** One authenticated user contributes 1 to a UTC day no matter how many events. */
export function uniqueActiveUsers(rows: UserActivityDay[], day?: UtcDay): number {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.active === false) continue;
    if (day && row.day !== day) continue;
    ids.add(row.user_id);
  }
  return ids.size;
}

export function uniqueActiveUsersInRange(rows: UserActivityDay[], from: UtcDay, to: UtcDay): number {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.active === false) continue;
    if (row.day < from || row.day >= to) continue;
    ids.add(row.user_id);
  }
  return ids.size;
}

export function rollingUniqueUsers(
  rows: UserActivityDay[],
  asOf: UtcDay,
  windowDays: number,
): number {
  const from = addUtcDays(asOf, -(windowDays - 1));
  return uniqueActiveUsersInRange(rows, from, addUtcDays(asOf, 1));
}

export function dauMauStickiness(dau: number | null, mau: number | null): number | null {
  if (dau == null || mau == null || mau <= 0) return null;
  return dau / mau;
}

export function windowAvailableFrom(availableFrom: UtcDay, windowDays: number): UtcDay {
  return addUtcDays(availableFrom, windowDays - 1);
}

export function isWindowMature(availableFrom: UtcDay, windowDays: number, asOf: UtcDay): boolean {
  return asOf >= windowAvailableFrom(availableFrom, windowDays);
}

export function trackedDaysComplete(availableFrom: UtcDay, asOf: UtcDay): number {
  if (asOf < availableFrom) return 0;
  const start = new Date(`${availableFrom}T00:00:00.000Z`).getTime();
  const end = new Date(`${asOf}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function resolveActivation(input: {
  firstClipSavedAt?: string | null;
  firstCloudUploadAt?: string | null;
}): {
  activatedAt: string | null;
  activationSource: ActivationSource | null;
  activationQuality: ActivationQuality | null;
} {
  const saved = input.firstClipSavedAt ?? null;
  const cloud = input.firstCloudUploadAt ?? null;
  if (!saved && !cloud) {
    return { activatedAt: null, activationSource: null, activationQuality: null };
  }
  if (saved && (!cloud || saved <= cloud)) {
    return { activatedAt: saved, activationSource: "local_clip", activationQuality: "exact" };
  }
  return {
    activatedAt: cloud,
    activationSource: "cloud_clip",
    activationQuality: saved ? "exact" : "cloud_proxy",
  };
}

export function neverMoveMilestoneLater(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming;
  if (!incoming) return current;
  return incoming < current ? incoming : current;
}

export function exactDayAfter(originIso: string, n: number): UtcDay {
  return addUtcDays(utcDay(new Date(originIso)), n);
}

/** Exact-day retention: activity on calendar day N after the cohort origin. */
export function retainedOnExactDay(originIso: string, activityDays: Iterable<string>, n: number): boolean {
  const target = exactDayAfter(originIso, n);
  if (activityDays instanceof Set) return activityDays.has(target);
  for (const day of activityDays) {
    if (day === target) return true;
  }
  return false;
}

/** D_n is mature after that calendar day has ended (asOf > origin + N). */
export function retentionDayMature(originDay: UtcDay, n: number, asOf: UtcDay): boolean {
  return asOf > addUtcDays(originDay, n);
}

export function cohortRetentionRate(
  origins: Array<{ user_id: string; origin_at: string }>,
  activityByUser: Map<string, Set<string>>,
  n: number,
  asOf: UtcDay,
): number | null {
  let eligible = 0;
  let retained = 0;
  for (const row of origins) {
    const originDay = utcDay(new Date(row.origin_at));
    if (!retentionDayMature(originDay, n, asOf)) continue;
    eligible += 1;
    if (retainedOnExactDay(row.origin_at, activityByUser.get(row.user_id) ?? new Set(), n)) {
      retained += 1;
    }
  }
  if (eligible === 0) return null;
  return retained / eligible;
}

export function activationWithin(
  signupAt: string,
  activatedAt: string | null,
  hours: number,
): boolean {
  if (!activatedAt) return false;
  return new Date(activatedAt).getTime() - new Date(signupAt).getTime() <= hours * 3_600_000;
}

export function cohortActivationRate(
  users: Array<{ signup_at: string; activated_at: string | null }>,
  windowDays: number,
  asOf: UtcDay,
): number | null {
  let eligible = 0;
  let activated = 0;
  for (const user of users) {
    const signupDay = utcDay(new Date(user.signup_at));
    if (!retentionDayMature(signupDay, windowDays, asOf)) continue;
    eligible += 1;
    if (activationWithin(user.signup_at, user.activated_at, windowDays * 24)) activated += 1;
  }
  if (eligible === 0) return null;
  return activated / eligible;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo] ?? null;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (index - lo);
}

export function durationMs(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function formatDurationMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function timeToActivationStats(
  users: Array<{ signup_at: string | null; activated_at: string | null; activation_quality: ActivationQuality | null }>,
  exactOnly = true,
): { n: number; p25: number | null; median: number | null; p75: number | null } {
  const values: number[] = [];
  for (const user of users) {
    if (exactOnly && user.activation_quality !== "exact") continue;
    const ms = durationMs(user.signup_at, user.activated_at);
    if (ms != null) values.push(ms);
  }
  return {
    n: values.length,
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
  };
}

export function newVsReturning(rows: UserActivityDay[], from: UtcDay, to: UtcDay): { neu: number; returning: number } {
  const firstDay = new Map<string, UtcDay>();
  for (const row of rows) {
    if (row.active === false) continue;
    const current = firstDay.get(row.user_id);
    if (!current || row.day < current) firstDay.set(row.user_id, row.day);
  }
  const inRange = new Set<string>();
  for (const row of rows) {
    if (row.active === false) continue;
    if (row.day >= from && row.day < to) inRange.add(row.user_id);
  }
  let neu = 0;
  let returning = 0;
  for (const userId of inRange) {
    const first = firstDay.get(userId);
    if (first && first >= from && first < to) neu += 1;
    else returning += 1;
  }
  return { neu, returning };
}

export function inactiveSegments(
  milestones: UserMilestone[],
  asOf: Date,
): Record<string, number> {
  const asOfMs = asOf.getTime();
  const day = 86_400_000;
  const counts = {
    active_today: 0,
    active_last_7: 0,
    inactive_7: 0,
    inactive_14: 0,
    inactive_30: 0,
    inactive_60: 0,
    never_activated: 0,
    activated_inactive_7: 0,
    paid_inactive: 0,
  };
  const today = utcDay(asOf);
  for (const user of milestones) {
    const last = user.last_active_at ? new Date(user.last_active_at).getTime() : null;
    const ageDays = last == null ? Infinity : (asOfMs - last) / day;
    if (last && utcDay(new Date(last)) === today) counts.active_today += 1;
    if (ageDays <= 7) counts.active_last_7 += 1;
    if (ageDays >= 7) counts.inactive_7 += 1;
    if (ageDays >= 14) counts.inactive_14 += 1;
    if (ageDays >= 30) counts.inactive_30 += 1;
    if (ageDays >= 60) counts.inactive_60 += 1;
    if (!user.activated_at) counts.never_activated += 1;
    if (user.activated_at && ageDays >= 7) counts.activated_inactive_7 += 1;
  }
  return counts;
}

export function cohortKey(originAt: string, grain: "day" | "week" | "month"): UtcDay {
  const day = utcDay(new Date(originAt));
  if (grain === "week") return utcWeekStart(day);
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  return day;
}

export function captureStartedCountsAsDau(): boolean {
  return false;
}

export function replayEnabledCountsAsDau(): boolean {
  return false;
}
