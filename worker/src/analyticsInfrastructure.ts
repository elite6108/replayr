export const GIB = 1024 ** 3;

export const STORAGE_BUCKETS = [
  { key: "0 GB", min: 0, max: 0 },
  { key: "<1 GB", min: 1, max: GIB - 1 },
  { key: "1–5 GB", min: GIB, max: 5 * GIB - 1 },
  { key: "5–10 GB", min: 5 * GIB, max: 10 * GIB - 1 },
  { key: "10–25 GB", min: 10 * GIB, max: 25 * GIB - 1 },
  { key: "25–50 GB", min: 25 * GIB, max: 50 * GIB - 1 },
  { key: "50–100 GB", min: 50 * GIB, max: 100 * GIB - 1 },
  { key: "100+ GB", min: 100 * GIB, max: null },
] as const;

export type CostAssumption = {
  provider: string;
  metric: string;
  unit: string;
  rate: number;
  currency: string;
  effective_from: string;
};

export type StorageUser = {
  user_id: string;
  storage_used_bytes: number;
  plan_slug: string;
  ready_clips: number;
  last_active_at: string | null;
  paid: boolean;
  complimentary: boolean;
};

export function storageBucket(bytes: number): string {
  const value = Math.max(0, bytes);
  for (const bucket of STORAGE_BUCKETS) {
    if (value >= bucket.min && (bucket.max == null || value <= bucket.max)) return bucket.key;
  }
  return "100+ GB";
}

export function storageSegments(users: Array<{ storage_used_bytes: number }>) {
  const totalUsers = users.length;
  const totalBytes = users.reduce((sum, row) => sum + Math.max(0, Number(row.storage_used_bytes || 0)), 0);
  return STORAGE_BUCKETS.map((bucket) => {
    const members = users.filter((row) => storageBucket(Number(row.storage_used_bytes || 0)) === bucket.key);
    const bytes = members.reduce((sum, row) => sum + Math.max(0, Number(row.storage_used_bytes || 0)), 0);
    return {
      key: bucket.key,
      users: members.length,
      shareOfUsers: totalUsers > 0 ? members.length / totalUsers : null,
      bytes,
      shareOfStorage: totalBytes > 0 ? bytes / totalBytes : null,
    };
  });
}

export function averageOrNull(total: number, count: number): number | null {
  if (count <= 0) return null;
  return total / count;
}

export function monthlyStorageCostCents(bytes: number, ratePerGbMonth: number | null): number | null {
  if (ratePerGbMonth == null || ratePerGbMonth < 0) return null;
  return Math.round((bytes / GIB) * ratePerGbMonth * 100);
}

export function latestAssumption(rows: CostAssumption[], provider: string, metric: string, asOf: string): CostAssumption | null {
  const eligible = rows
    .filter((row) => row.provider === provider && row.metric === metric && row.effective_from <= asOf && row.rate >= 0)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return eligible[0] ?? null;
}

export function forecastFromAverage(dailyAdded: number[], horizonDays: number): number | null {
  const values = dailyAdded.filter((value) => Number.isFinite(value));
  if (values.length < 3) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average < 0) return null;
  return average * horizonDays;
}

export function validateCostRate(rate: unknown): number {
  const next = Number(rate);
  if (!Number.isFinite(next) || next < 0) throw new Error("Rate must be a non-negative number.");
  return next;
}

export function topConsumers(users: StorageUser[], limit = 25): StorageUser[] {
  return [...users].sort((a, b) => b.storage_used_bytes - a.storage_used_bytes).slice(0, limit);
}
