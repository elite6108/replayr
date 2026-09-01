import { cohortRetentionRate, uniqueActiveUsersInRange, type UserActivityDay } from "./analyticsGrowth";
import type { UtcDay } from "./analyticsDates";

export const ANALYTICS_PRODUCT_AVAILABLE_FROM: UtcDay = "2026-08-31";
export const UNKNOWN_GAME_SLUG = "unknown";
export const POWER_USER_DECILE = 0.1;

export const FEATURE_LABELS: Record<string, string> = {
  app_open: "App open",
  clip_save: "Clip save",
  cloud_upload: "Cloud upload",
  editor: "Editor",
  render: "Render",
  play: "Clip play",
  share: "Share",
  folder: "Folders",
  filter: "Filters",
  capture: "Capture",
  replay: "Instant Replay",
};

export const FEATURE_ADOPTION_ONLY = new Set(["capture", "replay"]);

export type CountRow = { key: string; count: number };

export function clipsPerActiveUser(clipsSaved: number | null, activeUsers: number | null): number | null {
  if (clipsSaved == null || activeUsers == null || activeUsers <= 0) return null;
  return clipsSaved / activeUsers;
}

export function adoptionRate(featureUsers: number, activeUsers: number | null): number | null {
  if (activeUsers == null || activeUsers <= 0) return null;
  return featureUsers / activeUsers;
}

export function repeatRate(repeatUsers: number, uniqueUsers: number): number | null {
  if (uniqueUsers <= 0) return null;
  return repeatUsers / uniqueUsers;
}

/** Top decile by count. Ties at the cutoff stay in. Empty → []. */
export function powerUserIds(counts: Array<{ user_id: string; count: number }>, decile = POWER_USER_DECILE): string[] {
  const positive = counts.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
  if (positive.length === 0) return [];
  const cutoffIndex = Math.max(0, Math.ceil(positive.length * decile) - 1);
  const cutoff = positive[cutoffIndex]?.count ?? 0;
  return positive.filter((row) => row.count >= cutoff).map((row) => row.user_id);
}

export function histogram(values: number[], buckets: Array<{ key: string; min: number; max: number | null }>): CountRow[] {
  return buckets.map((bucket) => ({
    key: bucket.key,
    count: values.filter((value) => value >= bucket.min && (bucket.max == null || value <= bucket.max)).length,
  }));
}

export const CLIP_COUNT_BUCKETS = [
  { key: "1", min: 1, max: 1 },
  { key: "2-3", min: 2, max: 3 },
  { key: "4-7", min: 4, max: 7 },
  { key: "8-15", min: 8, max: 15 },
  { key: "16+", min: 16, max: null },
] as const;

export const DURATION_BUCKETS = [
  { key: "0-15s", min: 0, max: 14_999 },
  { key: "15-30s", min: 15_000, max: 29_999 },
  { key: "30-60s", min: 30_000, max: 59_999 },
  { key: "1-2m", min: 60_000, max: 119_999 },
  { key: "2-5m", min: 120_000, max: 299_999 },
  { key: "5m+", min: 300_000, max: null },
] as const;

export function shareOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
}

export function engagementRate(
  userIds: Iterable<string>,
  activity: UserActivityDay[],
  from: UtcDay,
  to: UtcDay,
): number | null {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return null;
  const active = uniqueActiveUsersInRange(
    activity.filter((row) => ids.includes(row.user_id)),
    from,
    to,
  );
  return active / ids.length;
}

export function paidShare(userIds: Iterable<string>, paidIds: Set<string>): number | null {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return null;
  return ids.filter((id) => paidIds.has(id)).length / ids.length;
}

export function isUsedFilter(filterId: string): boolean {
  return Boolean(filterId) && filterId !== "none" && filterId !== "unknown";
}

export function gameLabel(slug: string, name?: string | null): string {
  if (slug === UNKNOWN_GAME_SLUG) return "Unknown";
  return name || slug;
}

export function gameRetentionRows(
  firsts: Array<{ user_id: string; game_slug: string; first_ready_at: string }>,
  activityByUser: Map<string, Set<string>>,
  asOf: UtcDay,
  n = 7,
): Array<{ game_slug: string; users: number; eligible: number; rate: number | null }> {
  const byGame = new Map<string, Array<{ user_id: string; origin_at: string }>>();
  for (const row of firsts) {
    const list = byGame.get(row.game_slug) ?? [];
    list.push({ user_id: row.user_id, origin_at: row.first_ready_at });
    byGame.set(row.game_slug, list);
  }
  return [...byGame.entries()].map(([game_slug, origins]) => {
    const rate = cohortRetentionRate(origins, activityByUser, n, asOf);
    let eligible = 0;
    for (const origin of origins) {
      const originDay = origin.origin_at.slice(0, 10);
      if (asOf > addDays(originDay, n)) eligible += 1;
    }
    return { game_slug, users: origins.length, eligible, rate };
  });
}

function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
