import type { UserActivityDay } from "./analyticsGrowth";

export type ClippingUsage = {
  localClippers: number;
  cloudClippers: number;
  localOnlyClippers: number;
  cloudUploadingClippers: number;
  localThenCloud: number;
  conversion: number | null;
};

export type ClippingActivityDay = UserActivityDay & {
  clip_saved?: boolean;
  clip_uploaded?: boolean;
};

export function clippingUsageFromActivity(rows: ClippingActivityDay[]): ClippingUsage {
  const local = new Set<string>();
  const cloud = new Set<string>();
  for (const row of rows) {
    if (row.clip_saved) local.add(row.user_id);
    if (row.clip_uploaded) cloud.add(row.user_id);
  }
  let localThenCloud = 0;
  for (const userId of local) {
    if (cloud.has(userId)) localThenCloud += 1;
  }
  return {
    localClippers: local.size,
    cloudClippers: cloud.size,
    localOnlyClippers: local.size - localThenCloud,
    cloudUploadingClippers: cloud.size,
    localThenCloud,
    conversion: local.size ? localThenCloud / local.size : null,
  };
}

export function uniqueLocalClippersByDay(rows: ClippingActivityDay[], labels: string[]): Array<number | null> {
  const byDay = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.clip_saved) continue;
    const set = byDay.get(row.day) ?? new Set<string>();
    set.add(row.user_id);
    byDay.set(row.day, set);
  }
  return labels.map((day) => {
    const set = byDay.get(day);
    return set ? set.size : 0;
  });
}
