import { ANALYTICS_METRIC_CATALOG } from "./analyticsAvailability";
import { ANALYTICS_ACTIVITY_AVAILABLE_FROM } from "./analyticsGrowth";
import {
  ANALYTICS_DEFAULT_TZ,
  ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
  ANALYTICS_FIRST_DAY,
  addUtcDays,
  reportTitle,
  resolveReportPeriod,
  serializeComparisonRange,
  type ReportType,
  type UtcDay,
} from "./analyticsDates";
import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import { buildAnalyticsDownloads, buildAnalyticsOverview } from "./analyticsAdmin";
import { buildAnalyticsAcquisition, buildAnalyticsGrowth, buildAnalyticsRetention } from "./analyticsGrowthAdmin";
import { buildAnalyticsClips, buildAnalyticsFeatures, buildAnalyticsFolders, buildAnalyticsGames, buildAnalyticsSharing } from "./analyticsProductAdmin";
import { buildAnalyticsInfrastructure, buildAnalyticsRevenue } from "./analyticsEconomyAdmin";
import { buildAnalyticsHealth } from "./analyticsHealthAdmin";
import {
  buildCoverageNotes,
  buildExecutiveSummary,
  buildNeedsAttention,
  buildReportInsights,
  buildReportRecommendations,
  type ReportInsight,
  type ReportKpi,
  type ReportRecommendation,
} from "./analyticsReportInsights";
import type { Env } from "./env";
import { HttpError } from "./http";
import { serviceRest, withServiceRestCache } from "./shared";

export const ANALYTICS_REPORT_VERSION = 1;
export const ANALYTICS_METRIC_DICTIONARY_VERSION = 1;

export type { ReportType };
export const REPORT_TYPES: ReportType[] = ["daily", "weekly", "monthly", "quarterly", "ytd", "custom"];

export type AnalyticsReportSnapshot = {
  meta: {
    type: ReportType;
    from: UtcDay;
    to: UtcDay;
    label: string;
    title: string;
    timezone: string;
    generatedAt: string;
    generatedBy: string | null;
    reportVersion: number;
    dictionaryVersion: number;
  };
  comparison: ReturnType<typeof serializeComparisonRange>;
  kpis: ReportKpi[];
  downloads: {
    app: Record<string, number | null>;
    media: Record<string, number | null>;
    mediaTotal: number | null;
    series: { labels: string[]; installer: Array<number | null> };
    stats: { highest: { day: string; value: number } | null; lowest: { day: string; value: number } | null; average: number | null };
    tracking: { incomplete: boolean; trackedFrom: string | null; notice: string | null };
  };
  sections: {
    overview: unknown;
    downloads: unknown;
    growth: unknown;
    retention: unknown;
    acquisition: unknown;
    clips: unknown;
    games: unknown;
    features: unknown;
    folders: unknown;
    sharing: unknown;
    revenue: unknown;
    infrastructure: unknown;
    health: unknown;
  };
  availability: Record<string, string>;
  coverage: Array<{ key: string; label: string; status: string; note: string }>;
};

export type AnalyticsReportRow = {
  id: string;
  report_type: ReportType;
  period_start: string;
  period_end: string;
  display_timezone: string;
  title: string;
  generated_by: string | null;
  report_version: number;
  metric_dictionary_version: number | null;
  status: "ready" | "failed" | "generating";
  summary_json: Record<string, unknown>;
  metrics_json: AnalyticsReportSnapshot;
  availability_json: Record<string, string>;
  insights_json: ReportInsight[];
  recommendations_json: ReportRecommendation[];
  pdf_object_key: string | null;
  pdf_status: string | null;
  regenerated_from_id: string | null;
  created_at: string;
};

function pickKpi(metrics: AnalyticsKpi[] | undefined, key: string): ReportKpi | null {
  const row = metrics?.find((item) => item.key === key);
  if (!row) return null;
  return {
    key: row.key,
    label: row.label,
    value: row.value,
    previous: row.previous,
    percentageChange: row.percentageChange,
    availability: row.availability,
    unit: row.unit ?? null,
    badge: row.badge ?? null,
    tooltip: row.tooltip,
  };
}

function stripConsumerIds(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const row = value as { topConsumers?: Array<Record<string, unknown>> };
  if (!Array.isArray(row.topConsumers)) return value;
  return {
    ...row,
    topConsumers: row.topConsumers.map((item) => {
      const next = { ...item };
      delete next.userId;
      delete next.user_id;
      return next;
    }),
  };
}

function trackedStats(labels: string[], values: Array<number | null>) {
  const points = labels
    .map((day, index) => ({ day, value: values[index] }))
    .filter((row): row is { day: string; value: number } => row.value != null);
  if (!points.length) return { highest: null, lowest: null, average: null };
  const highest = points.reduce((best, row) => (row.value > best.value ? row : best));
  const lowest = points.reduce((best, row) => (row.value < best.value ? row : best));
  const average = points.reduce((sum, row) => sum + row.value, 0) / points.length;
  return { highest, lowest, average };
}

function reportQueryUrl(from: UtcDay, to: UtcDay, timezone: string, type: ReportType): URL {
  const url = new URL("https://www.replayr.tv/v1/admin/analytics/report");
  url.searchParams.set("range", "custom");
  url.searchParams.set("from", from);
  url.searchParams.set("to", addUtcDays(to, -1));
  url.searchParams.set("tz", timezone);
  url.searchParams.set("compare", "1");
  if (type === "monthly") url.searchParams.set("compareBasis", "calendar_month");
  if (type === "quarterly") url.searchParams.set("compareBasis", "calendar_quarter");
  return url;
}

async function loadSection<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (caught) {
    if (caught instanceof HttpError) throw new HttpError(caught.status, `${name}: ${caught.message}`);
    throw new HttpError(502, `${name}: ${caught instanceof Error ? caught.message : "failed"}`);
  }
}

export async function collectReportSections(env: Env, url: URL) {
  const overview = await loadSection("overview", () => buildAnalyticsOverview(env, url));
  const downloads = await loadSection("downloads", () => buildAnalyticsDownloads(env, url));
  const growth = await loadSection("growth", () => buildAnalyticsGrowth(env, url));
  const retention = await loadSection("retention", () => buildAnalyticsRetention(env, url));
  const acquisition = await loadSection("acquisition", () => buildAnalyticsAcquisition(env, url));
  const clips = await loadSection("clips", () => buildAnalyticsClips(env, url));
  const games = await loadSection("games", () => buildAnalyticsGames(env, url));
  const features = await loadSection("features", () => buildAnalyticsFeatures(env, url));
  const folders = await loadSection("folders", () => buildAnalyticsFolders(env, url));
  const sharing = await loadSection("sharing", () => buildAnalyticsSharing(env, url));
  const revenue = await loadSection("revenue", () => buildAnalyticsRevenue(env, url));
  const infrastructure = await loadSection("infrastructure", () => buildAnalyticsInfrastructure(env, url));
  const health = await loadSection("health", () => buildAnalyticsHealth(env, url));
  return {
    overview,
    downloads,
    growth,
    retention,
    acquisition,
    clips,
    games,
    features,
    folders,
    sharing,
    revenue,
    infrastructure,
    health,
  };
}

export function assembleReportSnapshot(input: {
  type: ReportType;
  from: UtcDay;
  to: UtcDay;
  label: string;
  timezone: string;
  generatedBy: string | null;
  generatedAt?: string;
  sections: Awaited<ReturnType<typeof collectReportSections>>;
}): { snapshot: AnalyticsReportSnapshot; insights: ReportInsight[]; recommendations: ReportRecommendation[]; summary: Record<string, unknown> } {
  const query = parseAdminAnalyticsQuery(reportQueryUrl(input.from, input.to, input.timezone, input.type));
  const comparison = serializeComparisonRange(query.comparison);
  const s = input.sections;
  const kpiList = [
    pickKpi(s.overview.metrics, "total_users"),
    pickKpi(s.growth.metrics, "new_users"),
    pickKpi(s.growth.metrics, "activated_users"),
    pickKpi(s.overview.metrics, "cloud_activated_users"),
    pickKpi(s.downloads.metrics, "installer_downloads"),
    pickKpi(s.clips.metrics, "ready_cloud_clips"),
    pickKpi(s.overview.metrics, "public_clip_views"),
    pickKpi(s.revenue.metrics, "paid_subscribers") ?? pickKpi(s.overview.metrics, "active_paid_subscribers_end_of_day"),
    pickKpi(s.revenue.metrics, "estimated_mrr_cents") ?? pickKpi(s.overview.metrics, "estimated_mrr_cents"),
    pickKpi(s.overview.metrics, "total_storage_bytes_end_of_day"),
    pickKpi(s.health.metrics, "upload_success_rate"),
    pickKpi(s.health.metrics, "error_events"),
    pickKpi(s.health.metrics, "clip_save_success_rate"),
    pickKpi(s.health.metrics, "render_success_rate"),
    pickKpi(s.growth.metrics, "activation_rate_7d"),
    pickKpi(s.growth.metrics, "dau"),
    pickKpi(s.growth.metrics, "wau"),
    pickKpi(s.growth.metrics, "mau"),
    pickKpi(s.health.metrics, "unique_affected_users"),
    pickKpi(s.health.metrics, "new_error_groups"),
  ].filter((row): row is ReportKpi => Boolean(row));

  const installerSeries = s.downloads.series.installer_downloads ?? { labels: [] as string[], values: [] as Array<number | null> };
  const games = ((s.games as { games?: Array<{ name: string; cloudClips: number; slug: string }> }).games ?? []).map((row) => ({
    name: row.name,
    clips: Number(row.cloudClips || 0),
    slug: row.slug,
  }));
  const cloudTotal = games.reduce((sum, row) => sum + row.clips, 0);
  const top = games[0] && games[0].clips >= 10 && cloudTotal > 0
    ? { name: games[0].name, share: games[0].clips / cloudTotal, clips: games[0].clips }
    : null;
  const regressions = ((s.health as { releases?: Array<{ version: string; potentialRegression: boolean }> }).releases ?? [])
    .filter((row) => row.potentialRegression)
    .map((row) => row.version);
  const newGroups = Number(pickKpi(s.health.metrics, "new_error_groups")?.value ?? 0);
  const healthErrors = (s.health as { errors?: Array<{ message: string; affectedUsers: number }> }).errors ?? [];
  const insights = buildReportInsights({
    kpis: kpiList,
    comparisonAvailable: comparison?.available !== false,
    comparisonComplete: comparison?.complete === true,
    newErrorGroupCount: newGroups,
    newErrorLabel: healthErrors[0]?.message ?? null,
    affectedUserCount: Number(pickKpi(s.health.metrics, "unique_affected_users")?.value ?? 0),
    topGame: top,
    regressions,
    folderRetentionNote: null,
  });
  const storageAdded = pickKpi(s.infrastructure?.metrics as AnalyticsKpi[] | undefined, "storage_bytes_added")
    ?? { key: "storage_bytes_added", label: "Storage Added", value: null, previous: null, percentageChange: null, availability: "INCOMPLETE" };
  const recommendations = buildReportRecommendations({
    kpis: kpiList,
    insights,
    regressions,
    storageAddedBytes: storageAdded.value,
    attention: (s.health as { attention?: string[] }).attention ?? [],
  });
  const attention = buildNeedsAttention({
    attention: (s.health as { attention?: string[] }).attention ?? [],
    insights,
    recommendations,
  });
  const title = reportTitle(input.type, input.from, input.to, input.label);
  const snapshot: AnalyticsReportSnapshot = {
    meta: {
      type: input.type,
      from: input.from,
      to: input.to,
      label: input.label,
      title,
      timezone: input.timezone,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      generatedBy: input.generatedBy,
      reportVersion: ANALYTICS_REPORT_VERSION,
      dictionaryVersion: ANALYTICS_METRIC_DICTIONARY_VERSION,
    },
    comparison,
    kpis: kpiList,
    downloads: {
      app: { ...s.downloads.breakdown.app },
      media: { ...s.downloads.breakdown.media },
      mediaTotal: s.downloads.metrics.find((item) => item.key === "media_downloads_total")?.value ?? null,
      series: { labels: [...installerSeries.labels], installer: [...installerSeries.values] },
      stats: trackedStats(installerSeries.labels, installerSeries.values),
      tracking: {
        incomplete: Boolean(s.downloads.tracking.incomplete),
        trackedFrom: s.downloads.tracking.trackedFrom,
        notice: s.downloads.tracking.notice,
      },
    },
    sections: {
      ...(JSON.parse(JSON.stringify(s)) as typeof s),
      infrastructure: stripConsumerIds(s.infrastructure),
    },
    availability: Object.fromEntries(ANALYTICS_METRIC_CATALOG.map((item) => [item.key, item.availability])),
    coverage: buildCoverageNotes({
      firstDay: ANALYTICS_FIRST_DAY,
      downloadsFrom: ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
      activityFrom: ANALYTICS_ACTIVITY_AVAILABLE_FROM,
    }),
  };
  const summary = {
    executive: buildExecutiveSummary({
      label: input.label,
      kpis: kpiList,
      insights,
      comparisonAvailable: comparison?.available !== false,
      comparisonComplete: comparison?.complete === true,
    }),
    attention,
  };
  return { snapshot, insights, recommendations, summary };
}

export async function generateAnalyticsReport(
  env: Env,
  input: {
    type: ReportType;
    date?: string;
    from?: string;
    toInclusive?: string;
    timezone?: string;
    generatedBy: string;
    regeneratedFromId?: string | null;
    periodOverride?: { from: UtcDay; to: UtcDay; label: string };
  },
): Promise<AnalyticsReportRow> {
  if (!REPORT_TYPES.includes(input.type)) throw new HttpError(400, "Unknown report type.");
  const timezone = input.timezone || ANALYTICS_DEFAULT_TZ;
  let period;
  try {
    period = input.periodOverride
      ? { type: input.type, ...input.periodOverride }
      : resolveReportPeriod(input.type, { date: input.date, from: input.from, toInclusive: input.toInclusive }, new Date(), timezone);
  } catch (caught) {
    throw new HttpError(400, caught instanceof Error ? caught.message : "Invalid report period.");
  }
  const url = reportQueryUrl(period.from, period.to, timezone, input.type);
  let assembled;
  try {
    const sections = await collectReportSections(withServiceRestCache(env), url);
    assembled = assembleReportSnapshot({
      type: input.type,
      from: period.from,
      to: period.to,
      label: period.label,
      timezone,
      generatedBy: input.generatedBy,
      sections,
    });
  } catch (caught) {
    if (caught instanceof HttpError) throw caught;
    throw new HttpError(502, caught instanceof Error ? caught.message : "Could not assemble the report snapshot.");
  }
  const rows = await serviceRest<AnalyticsReportRow[]>(
    env,
    "POST",
    "/analytics_reports",
    {
      report_type: input.type,
      period_start: period.from,
      period_end: period.to,
      display_timezone: timezone,
      title: assembled.snapshot.meta.title,
      generated_by: input.generatedBy,
      report_version: ANALYTICS_REPORT_VERSION,
      metric_dictionary_version: ANALYTICS_METRIC_DICTIONARY_VERSION,
      status: "ready",
      summary_json: assembled.summary,
      metrics_json: assembled.snapshot,
      availability_json: assembled.snapshot.availability,
      insights_json: assembled.insights,
      recommendations_json: assembled.recommendations,
      pdf_object_key: null,
      pdf_status: "on_demand",
      regenerated_from_id: input.regeneratedFromId ?? null,
    },
    "return=representation",
  );
  if (!rows[0]) throw new HttpError(502, "Could not save the report snapshot.");
  return rows[0];
}

export async function getAnalyticsReport(env: Env, id: string): Promise<AnalyticsReportRow> {
  const rows = await serviceRest<AnalyticsReportRow[]>(env, "GET", `/analytics_reports?id=eq.${id}&select=*`);
  if (!rows[0]) throw new HttpError(404, "That report was not found.");
  return rows[0];
}

export async function listAnalyticsReports(env: Env, cursor?: string | null) {
  const filters = ["select=id,report_type,period_start,period_end,display_timezone,title,generated_by,report_version,status,pdf_status,regenerated_from_id,created_at", "order=created_at.desc,id.desc", "limit=51"];
  if (cursor) filters.push(`created_at=lt.${cursor}`);
  const rows = await serviceRest<Array<Omit<AnalyticsReportRow, "summary_json" | "metrics_json" | "availability_json" | "insights_json" | "recommendations_json">>>(
    env,
    "GET",
    `/analytics_reports?${filters.join("&")}`,
  );
  const page = rows.slice(0, 50);
  const actors = [...new Set(page.map((row) => row.generated_by).filter(Boolean))] as string[];
  const people = actors.length
    ? await serviceRest<Array<{ id: string; username: string | null; display_name: string | null }>>(
        env,
        "GET",
        `/profiles?id=in.(${actors.join(",")})&select=id,username,display_name`,
      ).catch(() => [])
    : [];
  const names = new Map(people.map((row) => [row.id, row.display_name || row.username || "Admin"]));
  return {
    items: page.map((row) => ({
      id: row.id,
      reportType: row.report_type,
      title: row.title,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      periodEndInclusive: addUtcDays(row.period_end, -1),
      timezone: row.display_timezone,
      generatedAt: row.created_at,
      generatedBy: row.generated_by,
      generatedByLabel: row.generated_by ? names.get(row.generated_by) ?? "Admin" : "Admin",
      status: row.status,
      reportVersion: row.report_version,
      regeneratedFromId: row.regenerated_from_id,
    })),
    nextCursor: rows[50]?.created_at ?? null,
    limit: 50,
  };
}

export function presentReport(row: AnalyticsReportRow, generatedByLabel?: string | null) {
  return {
    id: row.id,
    reportType: row.report_type,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    periodEndInclusive: addUtcDays(row.period_end, -1),
    timezone: row.display_timezone,
    generatedAt: row.created_at,
    generatedBy: row.generated_by,
    generatedByLabel: generatedByLabel ?? "Admin",
    reportVersion: row.report_version,
    dictionaryVersion: row.metric_dictionary_version,
    status: row.status,
    pdfStatus: row.pdf_status,
    regeneratedFromId: row.regenerated_from_id,
    summary: row.summary_json,
    snapshot: row.metrics_json,
    insights: row.insights_json,
    recommendations: row.recommendations_json,
    availability: row.availability_json,
  };
}
