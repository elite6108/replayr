import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import {
  comparisonPeriodRange,
  daysInRange,
  formatRangeLabel,
  percentChange,
  serializeComparisonRange,
  zonedDayStartUtc,
  zonedWeekStart,
  type AnalyticsGranularity,
  type UtcDay,
} from "./analyticsDates";
import type { Env } from "./env";
import { serviceRest } from "./shared";

export type TrafficGranularity = "hour" | AnalyticsGranularity;

type TrafficTotals = { uniqueVisitors: number; signedIn: number; pings: number };
type TrafficSeriesPoint = { bucketStart: string; uniqueVisitors: number; signedIn: number; pings: number };
type TrafficSlice = { key: string; uniqueVisitors: number; pings: number };
type TrafficHour = { hour: number; uniqueVisitors: number; pings: number };

type VisitorTrafficReport = {
  totals: TrafficTotals;
  series: TrafficSeriesPoint[];
  surfaces: TrafficSlice[];
  countries: TrafficSlice[];
  paths: TrafficSlice[];
  hours: TrafficHour[];
};

function num(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

export function resolveTrafficGranularity(
  requested: string | null,
  from: UtcDay,
  to: UtcDay,
  fallback: AnalyticsGranularity,
): TrafficGranularity {
  if (requested === "hour" || requested === "day" || requested === "week" || requested === "month") return requested;
  if (daysInRange(from, to).length <= 2) return "hour";
  return fallback;
}

function kpi(key: string, label: string, current: number, previous: number | null, tooltip: string): AnalyticsKpi {
  return {
    key,
    label,
    value: current,
    previous,
    absoluteChange: previous != null ? current - previous : null,
    percentageChange: percentChange(current, previous),
    availability: "AVAILABLE",
    badge: null,
    tooltip,
    unit: "count",
    asOf: null,
  };
}

function emptyReport(): VisitorTrafficReport {
  return {
    totals: { uniqueVisitors: 0, signedIn: 0, pings: 0 },
    series: [],
    surfaces: [],
    countries: [],
    paths: [],
    hours: [],
  };
}

function parseReport(raw: unknown): VisitorTrafficReport {
  const body = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!body || typeof body !== "object") return emptyReport();
  const row = body as Record<string, unknown>;
  const totals = (row.totals && typeof row.totals === "object" ? row.totals : {}) as Record<string, unknown>;
  const series = Array.isArray(row.series) ? row.series : [];
  const surfaces = Array.isArray(row.surfaces) ? row.surfaces : [];
  const countries = Array.isArray(row.countries) ? row.countries : [];
  const paths = Array.isArray(row.paths) ? row.paths : [];
  const hours = Array.isArray(row.hours) ? row.hours : [];
  return {
    totals: {
      uniqueVisitors: num(totals.uniqueVisitors),
      signedIn: num(totals.signedIn),
      pings: num(totals.pings),
    },
    series: series.map((item) => {
      const point = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        bucketStart: String(point.bucketStart || ""),
        uniqueVisitors: num(point.uniqueVisitors),
        signedIn: num(point.signedIn),
        pings: num(point.pings),
      };
    }),
    surfaces: surfaces.map((item) => {
      const slice = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { key: String(slice.key || "unknown"), uniqueVisitors: num(slice.uniqueVisitors), pings: num(slice.pings) };
    }),
    countries: countries.map((item) => {
      const slice = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { key: String(slice.key || "ZZ"), uniqueVisitors: num(slice.uniqueVisitors), pings: num(slice.pings) };
    }),
    paths: paths.map((item) => {
      const slice = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { key: String(slice.key || "/"), uniqueVisitors: num(slice.uniqueVisitors), pings: num(slice.pings) };
    }),
    hours: hours.map((item) => {
      const slice = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { hour: num(slice.hour), uniqueVisitors: num(slice.uniqueVisitors), pings: num(slice.pings) };
    }),
  };
}

async function loadReport(
  env: Env,
  from: Date,
  to: Date,
  granularity: TrafficGranularity,
  tz: string,
): Promise<VisitorTrafficReport> {
  const raw = await serviceRest<unknown>(env, "POST", "/rpc/visitor_traffic_report", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_granularity: granularity,
    p_tz: tz,
  });
  return parseReport(raw);
}

function expectedBuckets(fromDay: UtcDay, toDay: UtcDay, granularity: TrafficGranularity, tz: string): Date[] {
  const from = zonedDayStartUtc(fromDay, tz);
  const to = zonedDayStartUtc(toDay, tz);
  if (granularity === "hour") {
    const buckets: Date[] = [];
    for (let time = from.getTime(); time < to.getTime(); time += 60 * 60 * 1000) {
      buckets.push(new Date(time));
    }
    return buckets;
  }
  if (granularity === "week") {
    const buckets: Date[] = [];
    const seen = new Set<string>();
    for (const day of daysInRange(fromDay, toDay)) {
      const week = zonedWeekStart(day, tz);
      if (seen.has(week)) continue;
      seen.add(week);
      buckets.push(zonedDayStartUtc(week, tz));
    }
    return buckets;
  }
  if (granularity === "month") {
    const buckets: Date[] = [];
    const seen = new Set<string>();
    for (const day of daysInRange(fromDay, toDay)) {
      const key = day.slice(0, 7);
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.push(zonedDayStartUtc(`${key}-01`, tz));
    }
    return buckets;
  }
  return daysInRange(fromDay, toDay).map((day) => zonedDayStartUtc(day, tz));
}

function formatBucketLabel(at: Date, granularity: TrafficGranularity, tz: string): string {
  if (granularity === "hour") {
    return at.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric" });
  }
  if (granularity === "month") {
    return at.toLocaleString("en-US", { timeZone: tz, month: "short", year: "numeric" });
  }
  return at.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}

function filledSeries(
  fromDay: UtcDay,
  toDay: UtcDay,
  granularity: TrafficGranularity,
  tz: string,
  points: TrafficSeriesPoint[],
): { labels: string[]; unique: Array<number | null>; signedIn: Array<number | null>; pings: Array<number | null> } {
  const byStart = new Map(points.map((point) => [new Date(point.bucketStart).getTime(), point]));
  const labels: string[] = [];
  const unique: Array<number | null> = [];
  const signedIn: Array<number | null> = [];
  const pings: Array<number | null> = [];
  for (const bucket of expectedBuckets(fromDay, toDay, granularity, tz)) {
    labels.push(formatBucketLabel(bucket, granularity, tz));
    const point = byStart.get(bucket.getTime());
    unique.push(point ? point.uniqueVisitors : 0);
    signedIn.push(point ? point.signedIn : 0);
    pings.push(point ? point.pings : 0);
  }
  return { labels, unique, signedIn, pings };
}

function hourSeries(hours: TrafficHour[]): { labels: string[]; unique: Array<number | null>; pings: Array<number | null> } {
  const byHour = new Map(hours.map((row) => [row.hour, row]));
  const labels: string[] = [];
  const unique: Array<number | null> = [];
  const pings: Array<number | null> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const suffix = hour === 0 ? "12am" : hour === 12 ? "12pm" : hour < 12 ? `${hour}am` : `${hour - 12}pm`;
    labels.push(suffix);
    const row = byHour.get(hour);
    unique.push(row ? row.uniqueVisitors : 0);
    pings.push(row ? row.pings : 0);
  }
  return { labels, unique, pings };
}

export async function buildVisitorTraffic(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const granularity = resolveTrafficGranularity(
    url.searchParams.get("granularity"),
    query.from,
    query.to,
    query.granularity,
  );
  const from = zonedDayStartUtc(query.from, query.tz);
  const to = zonedDayStartUtc(query.to, query.tz);
  const current = await loadReport(env, from, to, granularity, query.tz);
  const previousSpan = comparisonPeriodRange(query.comparison);
  const previous = previousSpan
    ? await loadReport(
        env,
        zonedDayStartUtc(previousSpan.from, query.tz),
        zonedDayStartUtc(previousSpan.to, query.tz),
        granularity,
        query.tz,
      )
    : null;
  const series = filledSeries(query.from, query.to, granularity, query.tz, current.series);
  const hours = hourSeries(current.hours);

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated: new Date().toISOString(),
    freshness: "hourly" as const,
    note: "Unique visitors are counted once per hour. IPs are not stored in this history.",
    metrics: [
      kpi(
        "visitor_uniques",
        "Unique visitors",
        current.totals.uniqueVisitors,
        previous?.totals.uniqueVisitors ?? null,
        "Distinct visitor keys in the selected range.",
      ),
      kpi(
        "visitor_signed_in",
        "Signed-in visitors",
        current.totals.signedIn,
        previous?.totals.signedIn ?? null,
        "Unique visitors that were signed in at least once in the range.",
      ),
      kpi(
        "visitor_pings",
        "Presence pings",
        current.totals.pings,
        previous?.totals.pings ?? null,
        "Heartbeats after a 10-second throttle. Not page views.",
      ),
    ],
    breakdown: {
      surfaces: current.surfaces,
      countries: current.countries.map((row) => ({
        ...row,
        key: row.key === "ZZ" ? "Unknown" : row.key,
      })),
      paths: current.paths,
    },
    series: {
      labels: series.labels,
      uniqueVisitors: series.unique,
      signedIn: series.signedIn,
      pings: series.pings,
      hourLabels: hours.labels,
      hourUniques: hours.unique,
      hourPings: hours.pings,
    },
  };
}
