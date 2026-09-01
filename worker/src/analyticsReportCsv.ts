import type { AnalyticsReportRow, AnalyticsReportSnapshot } from "./analyticsReport";
import { HttpError } from "./http";

export const REPORT_CSV_TOPICS = [
  "downloads",
  "users",
  "growth",
  "acquisition",
  "retention",
  "clips",
  "games",
  "features",
  "filters",
  "folders",
  "sharing",
  "revenue",
  "infrastructure",
  "health",
] as const;

export type ReportCsvTopic = (typeof REPORT_CSV_TOPICS)[number];

const FORBIDDEN = /secret|token|cookie|jwt|password|authorization|email|storage_key|object_key|signed|stack|message_body/i;

export function csvEscape(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  if (headers.some((header) => FORBIDDEN.test(header))) throw new HttpError(500, "CSV refused a sensitive header.");
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map((cell) => csvEscape(cell)).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

function seriesCsv(labels: string[], columns: Record<string, Array<number | null | undefined>>): { headers: string[]; rows: Array<Array<string | number | null>> } {
  const keys = Object.keys(columns);
  return {
    headers: ["day", ...keys],
    rows: labels.map((day, index) => [day, ...keys.map((key) => columns[key][index] ?? null)]),
  };
}

export function buildReportCsv(row: AnalyticsReportRow, topic: string): { filename: string; body: string } {
  if (!REPORT_CSV_TOPICS.includes(topic as ReportCsvTopic)) throw new HttpError(400, "Unknown export topic.");
  const snap = row.metrics_json as AnalyticsReportSnapshot;
  const from = snap.meta.from;
  const to = snap.meta.to;
  const filename = `replayr-${topic}-${from}_${to}.csv`;
  const emptyNote = toCsv(["note"], [["No tracked data for this period"]]);

  if (topic === "downloads") {
    const labels = snap.downloads.series.labels;
    if (!labels.length) return { filename, body: emptyNote };
    const built = seriesCsv(labels, { installer_downloads: snap.downloads.series.installer });
    return { filename, body: toCsv(built.headers, built.rows) };
  }

  const sections = snap.sections as Record<string, { series?: { labels?: string[] } & Record<string, Array<number | null>>; metrics?: Array<{ key: string; value: number | null; previous: number | null; availability: string }>; games?: Array<Record<string, unknown>>; features?: Array<Record<string, unknown>>; filters?: Array<Record<string, unknown>> }>;

  if (topic === "users" || topic === "growth") {
    const series = (sections.growth?.series ?? {}) as { labels?: string[]; new_users?: Array<number | null>; activated?: Array<number | null>; dau?: Array<number | null> };
    const labels = series.labels ?? [];
    if (!labels.length) return { filename, body: emptyNote };
    const built = seriesCsv(labels, {
      new_users: series.new_users ?? [],
      activated: series.activated ?? [],
      dau: series.dau ?? [],
    });
    return { filename, body: toCsv(built.headers, built.rows) };
  }

  if (topic === "health") {
    const series = (sections.health?.series ?? {}) as { labels?: string[]; errors?: Array<number | null>; uploadFailed?: Array<number | null> };
    const labels = series.labels ?? [];
    if (!labels.length) return { filename, body: emptyNote };
    const built = seriesCsv(labels, { error_events: series.errors ?? [], upload_failed: series.uploadFailed ?? [] });
    return { filename, body: toCsv(built.headers, built.rows) };
  }

  if (topic === "games") {
    const games = (sections.games as { games?: Array<{ slug: string; name: string; cloudClips: number; uniqueUploaders: number; publicViews: number }> })?.games ?? [];
    if (!games.length) return { filename, body: emptyNote };
    return {
      filename,
      body: toCsv(
        ["game_slug", "game_name", "cloud_clips", "unique_uploaders", "public_views"],
        games.map((item) => [item.slug, item.name, item.cloudClips, item.uniqueUploaders, item.publicViews]),
      ),
    };
  }

  const metrics = (
    topic === "revenue" ? sections.revenue?.metrics
    : topic === "infrastructure" ? sections.infrastructure?.metrics
    : topic === "clips" ? sections.clips?.metrics
    : topic === "folders" ? sections.folders?.metrics
    : topic === "sharing" ? sections.sharing?.metrics
    : topic === "features" ? sections.features?.metrics
    : topic === "filters" ? sections.features?.metrics
    : topic === "acquisition" ? sections.acquisition?.metrics
    : topic === "retention" ? sections.retention?.metrics
    : []
  ) ?? [];
  if (!metrics.length) return { filename, body: emptyNote };
  return {
    filename,
    body: toCsv(
      ["metric_key", "value", "previous", "availability"],
      metrics.map((item) => [item.key, item.value, item.previous, item.availability]),
    ),
  };
}

export function csvContainsForbidden(body: string): boolean {
  return FORBIDDEN.test(body) && /eyJ|sk_live|Bearer /.test(body);
}
