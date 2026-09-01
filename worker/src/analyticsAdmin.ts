import { ANALYTICS_METRIC_CATALOG, type MetricAvailability } from "./analyticsAvailability";
import {
  addUtcDays,
  ANALYTICS_DEFAULT_TZ,
  ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
  bucketKey,
  comparisonPeriodRange,
  cumulativeThrough,
  daysInRange,
  defaultGranularity,
  formatRangeLabel,
  halfOpenUtcRange,
  percentChange,
  clipRequestedComparison,
  monthRange,
  previousPeriod,
  resolveAnalyticsPreset,
  utcQuarterRange,
  serializeComparisonRange,
  type AnalyticsGranularity,
  type AnalyticsPreset,
  type UtcDay,
} from "./analyticsDates";
import {
  getClipDailySeries,
  getDownloadDailySeries,
  getOverviewDailySeries,
  getStorageDailySeries,
  getSubscriptionDailySeries,
} from "./analyticsQueries";
import type { Env } from "./env";
import { HttpError } from "./http";

export type AnalyticsKpi = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  absoluteChange: number | null;
  percentageChange: number | "new" | null;
  availability: MetricAvailability;
  badge?: "proxy" | "estimate" | "incomplete" | null;
  tooltip?: string;
  unit?: "count" | "bytes" | "cents" | "percent" | "duration_ms";
  asOf?: string | null;
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function sum(rows: Array<Record<string, unknown>>, key: string): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = num(row[key]);
    if (value == null) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function lastPresent(rows: Array<Record<string, unknown>>, key: string): { value: number; day: string } | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = num(rows[i]?.[key]);
    if (value != null) return { value, day: String(rows[i].day) };
  }
  return null;
}

function kpi(
  key: string,
  label: string,
  current: number | null,
  previous: number | null,
  extras: Partial<AnalyticsKpi> = {},
): AnalyticsKpi {
  const availability = extras.availability ?? (ANALYTICS_METRIC_CATALOG.find((item) => item.key === key)?.availability ?? "AVAILABLE");
  return {
    key,
    label,
    value: current,
    previous,
    absoluteChange: current != null && previous != null ? current - previous : null,
    percentageChange: percentChange(current, previous),
    availability,
    badge: extras.badge ?? null,
    tooltip: extras.tooltip,
    unit: extras.unit ?? "count",
    asOf: extras.asOf ?? null,
  };
}

function parsePreset(value: string | null): AnalyticsPreset {
  const allowed: AnalyticsPreset[] = [
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "last_7",
    "last_14",
    "last_30",
    "last_90",
    "this_month",
    "last_month",
    "ytd",
    "all_time",
    "custom",
  ];
  if (value && allowed.includes(value as AnalyticsPreset)) return value as AnalyticsPreset;
  return "last_30";
}

function parseGranularity(value: string | null): AnalyticsGranularity | undefined {
  if (value === "day" || value === "week" || value === "month") return value;
  return undefined;
}

function requestedPreviousFromQuery(url: URL, from: UtcDay, to: UtcDay) {
  const basis = url.searchParams.get("compareBasis");
  if (basis === "calendar_month") return monthRange(addUtcDays(from, -1));
  if (basis === "calendar_quarter") return utcQuarterRange(addUtcDays(from, -1));
  return previousPeriod(from, to);
}

export function parseAdminAnalyticsQuery(url: URL, now = new Date()) {
  const preset = parsePreset(url.searchParams.get("range") || url.searchParams.get("preset"));
  const tz = url.searchParams.get("tz") || ANALYTICS_DEFAULT_TZ;
  const compare = url.searchParams.get("compare") !== "0";
  const customFrom = url.searchParams.get("from");
  const customTo = url.searchParams.get("to");
  let resolved;
  try {
    resolved = resolveAnalyticsPreset(
      preset,
      now,
      tz,
      customFrom && customTo ? { from: customFrom, toInclusive: customTo } : undefined,
    );
  } catch (caught) {
    throw new HttpError(400, caught instanceof Error ? caught.message : "Invalid analytics range.");
  }
  const { from, to } = halfOpenUtcRange(resolved.from, resolved.to);
  const granularity = parseGranularity(url.searchParams.get("granularity")) ?? defaultGranularity(from, to);
  return {
    preset: resolved.preset,
    from,
    to,
    tz,
    compare,
    granularity,
    comparison: compare ? clipRequestedComparison(requestedPreviousFromQuery(url, from, to)) : null,
  };
}

function seriesFromRows(
  days: UtcDay[],
  rows: Array<Record<string, unknown>>,
  key: string,
  granularity: AnalyticsGranularity,
  tz: string,
  availableFrom?: string | null,
) {
  const buckets = new Map<string, { total: number; seen: boolean }>();
  const labels: string[] = [];
  for (const day of days) {
    const bucket = bucketKey(day, granularity, tz);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { total: 0, seen: false });
      labels.push(bucket);
    }
    if (availableFrom && day < availableFrom) continue;
    const row = rows.find((item) => item.day === day);
    const value = num(row?.[key]);
    if (value == null) continue;
    const next = buckets.get(bucket)!;
    next.total += value;
    next.seen = true;
  }
  return {
    labels,
    values: labels.map((label) => {
      const bucket = buckets.get(label)!;
      return bucket.seen ? bucket.total : null;
    }),
  };
}

export async function buildAnalyticsOverview(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const currentCumulative = cumulativeThrough(query.to);
  const previousPeriodRange = comparisonPeriodRange(query.comparison);
  const previousCumulative = query.comparison ? cumulativeThrough(query.comparison.requested.to) : null;
  const [overview, clips, storage, subs, downloads, priorUsers] = await Promise.all([
    getOverviewDailySeries(env, { from: query.from, to: query.to }),
    getClipDailySeries(env, { from: query.from, to: query.to }),
    getStorageDailySeries(env, { from: query.from, to: query.to }),
    getSubscriptionDailySeries(env, { from: query.from, to: query.to }),
    getDownloadDailySeries(env, { from: query.from, to: query.to }),
    currentCumulative ? getOverviewDailySeries(env, currentCumulative) : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const emptySeries = { rows: [] as Record<string, unknown>[] };
  const [prevOverview, prevClips, prevStorageSeries, prevSubs, prevDownloads, prevUsers] = previousPeriodRange
    ? await Promise.all([
        getOverviewDailySeries(env, previousPeriodRange),
        getClipDailySeries(env, previousPeriodRange),
        getStorageDailySeries(env, previousPeriodRange),
        getSubscriptionDailySeries(env, previousPeriodRange),
        getDownloadDailySeries(env, previousPeriodRange),
        previousCumulative ? getOverviewDailySeries(env, previousCumulative) : Promise.resolve(emptySeries),
      ])
    : [
        emptySeries,
        emptySeries,
        emptySeries,
        emptySeries,
        emptySeries,
        previousCumulative ? await getOverviewDailySeries(env, previousCumulative) : emptySeries,
      ];
  const periodPrevious = Boolean(previousPeriodRange);

  const days = daysInRange(query.from, query.to);
  const storageEnd = lastPresent(storage.rows, "total_storage_bytes_end_of_day");
  const paidEnd = lastPresent(subs.rows, "active_paid_subscribers_end_of_day");
  const mrrEnd = lastPresent(subs.rows, "estimated_mrr_cents");
  const prevStorage = periodPrevious ? lastPresent(prevStorageSeries.rows, "total_storage_bytes_end_of_day") : null;
  const prevPaid = periodPrevious ? lastPresent(prevSubs.rows, "active_paid_subscribers_end_of_day") : null;
  const prevMrr = periodPrevious ? lastPresent(prevSubs.rows, "estimated_mrr_cents") : null;

  const metrics = [
    kpi("total_users", "Total Users", sum(priorUsers.rows, "new_users"), previousCumulative ? sum(prevUsers.rows, "new_users") : null, {
      tooltip: "Cumulative new users through the end of the selected range. Not a sum of daily totals.",
    }),
    kpi("new_users", "New Users", sum(overview.rows, "new_users"), periodPrevious ? sum(prevOverview.rows, "new_users") : null),
    kpi(
      "cloud_activated_users",
      "Cloud Activated",
      sum(overview.rows, "cloud_activated_users"),
      periodPrevious ? sum(prevOverview.rows, "cloud_activated_users") : null,
      {
        badge: "proxy",
        tooltip: "Cloud Activated currently means first ready cloud clip. Local clip saves are not instrumented yet.",
      },
    ),
    kpi(
      "cloud_upload_completed",
      "Clips Uploaded",
      sum(clips.rows, "cloud_upload_completed"),
      periodPrevious ? sum(prevClips.rows, "cloud_upload_completed") : null,
    ),
    kpi(
      "ready_cloud_clips_created",
      "Ready Cloud Clips",
      sum(clips.rows, "ready_cloud_clips_created"),
      periodPrevious ? sum(prevClips.rows, "ready_cloud_clips_created") : null,
    ),
    kpi(
      "public_clip_views",
      "Public Clip Views",
      sum(clips.rows, "public_clip_views"),
      periodPrevious ? sum(prevClips.rows, "public_clip_views") : null,
      { tooltip: "clip_daily_views only. Folder playback is not included." },
    ),
    kpi("total_storage_bytes_end_of_day", "Total Cloud Storage", storageEnd?.value ?? null, prevStorage?.value ?? null, {
      unit: "bytes",
      asOf: storageEnd?.day ?? null,
      tooltip: "Point-in-time / end of day. Original cloud media quota only. Not a sum of daily storage.",
    }),
    kpi("storage_bytes_added", "Storage Added", sum(storage.rows, "storage_bytes_added"), periodPrevious ? sum(prevStorageSeries.rows, "storage_bytes_added") : null, {
      unit: "bytes",
      tooltip: "Original MP4 bytes of ready clips created in the range.",
    }),
    kpi(
      "active_paid_subscribers_end_of_day",
      "Active Paid Subscribers",
      paidEnd?.value ?? null,
      prevPaid?.value ?? null,
      { asOf: paidEnd?.day ?? null, tooltip: "Snapshot for the current UTC day when available." },
    ),
    kpi("estimated_mrr_cents", "Estimated MRR", mrrEnd?.value ?? null, prevMrr?.value ?? null, {
      unit: "cents",
      badge: "estimate",
      asOf: mrrEnd?.day ?? null,
      tooltip: "MRR is estimated from configured plan prices, not stored Stripe invoice amounts.",
    }),
    kpi(
      "installer_downloads",
      "App Installer Downloads",
      sum(downloads.rows, "installer_downloads"),
      periodPrevious ? sum(prevDownloads.rows, "installer_downloads") : null,
    ),
    kpi(
      "media_downloads_total",
      "Media Downloads",
      sum(downloads.rows, "media_downloads_total"),
      periodPrevious ? sum(prevDownloads.rows, "media_downloads_total") : null,
    ),
  ];

  const lastUpdated =
    [...overview.rows, ...clips.rows, ...storage.rows, ...subs.rows, ...downloads.rows]
      .map((row) => String(row.updated_at || ""))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated,
    freshness: "hourly" as const,
    tracking: { downloadsAvailableFrom: ANALYTICS_DOWNLOADS_AVAILABLE_FROM },
    availability: Object.fromEntries(ANALYTICS_METRIC_CATALOG.map((item) => [item.key, item.availability])),
    metrics,
    series: {
      new_users: seriesFromRows(days, overview.rows, "new_users", query.granularity, query.tz),
      cloud_activated_users: seriesFromRows(days, overview.rows, "cloud_activated_users", query.granularity, query.tz),
      cloud_upload_completed: seriesFromRows(days, clips.rows, "cloud_upload_completed", query.granularity, query.tz),
      installer_downloads: seriesFromRows(
        days,
        downloads.rows,
        "installer_downloads",
        query.granularity,
        query.tz,
        ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
      ),
    },
  };
}

export async function buildAnalyticsDownloads(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const current = await getDownloadDailySeries(env, { from: query.from, to: query.to });
  const previousRange = comparisonPeriodRange(query.comparison);
  const previous = previousRange ? await getDownloadDailySeries(env, previousRange) : null;
  const days = daysInRange(query.from, query.to);
  const trackedFrom = days.find((day) => day >= ANALYTICS_DOWNLOADS_AVAILABLE_FROM) ?? null;
  const incomplete = Boolean(days.some((day) => day < ANALYTICS_DOWNLOADS_AVAILABLE_FROM));

  const keys = [
    ["installer_downloads", "Installer Downloads"],
    ["app_download_clicks", "Download Button Clicks"],
    ["media_downloads_total", "Media Downloads"],
    ["clip_downloads_authenticated", "Authenticated Clip Downloads"],
    ["clip_downloads_public", "Public Clip Downloads"],
    ["folder_public_downloads", "Public Folder Downloads"],
  ] as const;

  const metrics = keys.map(([key, label]) =>
    kpi(key, label, sum(current.rows, key), previous ? sum(previous.rows, key) : null),
  );

  const clicks = sum(current.rows, "app_download_clicks");
  const installers = sum(current.rows, "installer_downloads");
  const conversion =
    clicks != null && clicks > 0 && installers != null ? installers / clicks : clicks === 0 && installers === 0 ? null : installers && !clicks ? "new" : null;

  const lastUpdated =
    current.rows
      .map((row) => String(row.updated_at || ""))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated,
    freshness: "hourly" as const,
    tracking: {
      downloadsAvailableFrom: ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
      incomplete,
      trackedFrom: incomplete ? trackedFrom : query.from,
      notice: incomplete
        ? `Download tracking began ${ANALYTICS_DOWNLOADS_AVAILABLE_FROM}. Earlier dates are unavailable.`
        : null,
    },
    metrics,
    conversion: {
      clicks,
      installers,
      rate: typeof conversion === "number" ? conversion : null,
      label: conversion === "new" ? "New" : null,
      note: "Installer counts are successful full-file GET 200s. Clicks are not downloads. Range/resume requests are not counted.",
    },
    breakdown: {
      app: {
        installer_downloads: sum(current.rows, "installer_downloads"),
        app_download_clicks: sum(current.rows, "app_download_clicks"),
      },
      media: {
        clip_downloads_authenticated: sum(current.rows, "clip_downloads_authenticated"),
        clip_downloads_public: sum(current.rows, "clip_downloads_public"),
        folder_public_downloads: sum(current.rows, "folder_public_downloads"),
      },
    },
    series: {
      installer_downloads: seriesFromRows(days, current.rows, "installer_downloads", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
      app_download_clicks: seriesFromRows(days, current.rows, "app_download_clicks", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
      clip_downloads_authenticated: seriesFromRows(days, current.rows, "clip_downloads_authenticated", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
      clip_downloads_public: seriesFromRows(days, current.rows, "clip_downloads_public", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
      folder_public_downloads: seriesFromRows(days, current.rows, "folder_public_downloads", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
      media_downloads_total: seriesFromRows(days, current.rows, "media_downloads_total", query.granularity, query.tz, ANALYTICS_DOWNLOADS_AVAILABLE_FROM),
    },
  };
}
