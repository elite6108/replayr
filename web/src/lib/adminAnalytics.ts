import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

export type AnalyticsKpi = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  absoluteChange: number | null;
  percentageChange: number | "new" | null;
  availability: string;
  badge?: "proxy" | "estimate" | "incomplete" | null;
  tooltip?: string;
  unit?: "count" | "bytes" | "cents" | "percent" | "duration_ms";
  asOf?: string | null;
};

export type AnalyticsSeries = { labels: string[]; values: Array<number | null> };

export type AnalyticsComparisonRange = {
  from: string;
  to: string;
  label: string;
  available?: boolean;
  complete?: boolean;
  reason?: string | null;
  requestedFrom?: string;
  requestedTo?: string;
} | null;

export function comparisonCaption(range: AnalyticsComparisonRange): string {
  if (!range) return "";
  if (range.available === false) return range.reason ? ` · ${range.reason}` : "";
  if (range.complete === false) return ` · vs ${range.label} (incomplete)`;
  return ` · vs ${range.label}`;
}

export type AnalyticsOverviewResponse = {
  range: { from: string; to: string; label: string; tz: string; preset: string; granularity: string };
  comparisonRange: AnalyticsComparisonRange;
  lastUpdated: string | null;
  freshness: "hourly";
  tracking: { downloadsAvailableFrom: string };
  metrics: AnalyticsKpi[];
  series: Record<string, AnalyticsSeries>;
};

export type AnalyticsDownloadsResponse = {
  range: { from: string; to: string; label: string; tz: string; preset: string; granularity: string };
  comparisonRange: AnalyticsComparisonRange;
  lastUpdated: string | null;
  freshness: "hourly";
  tracking: {
    downloadsAvailableFrom: string;
    incomplete: boolean;
    trackedFrom: string | null;
    notice: string | null;
  };
  metrics: AnalyticsKpi[];
  conversion: { clicks: number | null; installers: number | null; rate: number | null; label: string | null; note: string };
  breakdown: {
    app: { installer_downloads: number | null; app_download_clicks: number | null };
    media: {
      clip_downloads_authenticated: number | null;
      clip_downloads_public: number | null;
      folder_public_downloads: number | null;
    };
  };
  series: Record<string, AnalyticsSeries>;
};

async function adminFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    headers: { authorization: `Bearer ${token}` },
  });
  return readApiJson<T>(response, "Could not load analytics.");
}

export function fetchAnalyticsOverview(token: string, search: string) {
  return adminFetch<AnalyticsOverviewResponse>(`/v1/admin/analytics/overview${search}`, token);
}

export function fetchAnalyticsDownloads(token: string, search: string) {
  return adminFetch<AnalyticsDownloadsResponse>(`/v1/admin/analytics/downloads${search}`, token);
}

export type AnalyticsFunnelStage = {
  name: string;
  count: number | null;
  fromPrevious: number | null;
  fromFirst: number | null;
  availability: string;
};

export type AnalyticsGrowthResponse = {
  range: AnalyticsOverviewResponse["range"];
  comparisonRange: AnalyticsOverviewResponse["comparisonRange"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  tracking: { activityAvailableFrom: string; wauAvailableFrom: string; mauAvailableFrom: string; trackedDays: number };
  metrics: AnalyticsKpi[];
  timing: { exactOnly: boolean; n: number; median: number | null; medianLabel: string | null; p25Label: string | null; p75Label: string | null };
  activationWindows: Array<{ hours: number; rate: number | null }>;
  newVsReturning: { newActive: number; returningActive: number };
  segments: Record<string, number>;
  funnel: AnalyticsFunnelStage[];
  downloadFunnel: { note: string; stages: AnalyticsFunnelStage[] };
  insights: string[];
  series: { labels: string[]; dau: Array<number | null>; wau: Array<number | null>; mau: Array<number | null> };
};

export type AnalyticsRetentionResponse = {
  range: AnalyticsOverviewResponse["range"] & { cohort: string };
  definition: Record<string, string>;
  tracking: { activityAvailableFrom: string; notice: string | null };
  periods: number[];
  rows: Array<Record<string, string | number | null>>;
  curve: Array<{ day: number; rate: number | null }>;
};

export type AnalyticsAcquisitionResponse = {
  range: AnalyticsOverviewResponse["range"];
  coverage: {
    newUsers: number;
    attributed: number;
    unknown: number;
    direct: number;
    rate: number | null;
    note: string;
  };
  conversion: { userLevel: number | null; periodLevel: number | null; label: string | null; note: string; installerDownloads: number; userLevelMatches: number };
  sources: Array<{
    source: string;
    label: string;
    signups: number;
    activated: number;
    activationRate: number | null;
    shareOfAll: number | null;
  }>;
};

export function fetchAnalyticsGrowth(token: string, search: string) {
  return adminFetch<AnalyticsGrowthResponse>(`/v1/admin/analytics/growth${search}`, token);
}

export function fetchAnalyticsRetention(token: string, search: string) {
  return adminFetch<AnalyticsRetentionResponse>(`/v1/admin/analytics/retention${search}`, token);
}

export function fetchAnalyticsAcquisition(token: string, search: string) {
  return adminFetch<AnalyticsAcquisitionResponse>(`/v1/admin/analytics/acquisition${search}`, token);
}

export type AnalyticsClipsResponse = {
  range: AnalyticsOverviewResponse["range"];
  comparisonRange: AnalyticsOverviewResponse["comparisonRange"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  distributions: {
    clipsPerUser: Array<{ key: string; count: number }>;
    duration: Array<{ key: string; count: number }>;
    visibility: { public: number; unlisted: number; private: number };
  };
  powerUsers: { count: number; paidShare: number | null; medianClips: number | null; note: string };
  series: { labels: string[]; clips_saved: Array<number | null>; ready_cloud_clips: Array<number | null> };
};

export type AnalyticsGamesResponse = {
  range: AnalyticsOverviewResponse["range"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  games: Array<{
    slug: string;
    name: string;
    cloudClips: number;
    uniqueUploaders: number;
    publicViews: number;
    clipsSaved: number | null;
    retentionD7: number | null;
    retentionEligible: number;
    retentionUsers: number;
  }>;
  insights: string[];
};

export type AnalyticsFeaturesResponse = {
  range: AnalyticsOverviewResponse["range"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  features: Array<{
    key: string;
    label: string;
    uniqueUsers: number;
    eventCount: number;
    repeatUsers: number;
    adoption: number | null;
    repeatRate: number | null;
    dau: boolean;
  }>;
  filters: Array<{
    id: string;
    used: boolean;
    selected: number;
    applied: number;
    rendered: number;
    uniqueUsers: number;
    shared: number;
  }>;
  powerUsers: { count: number; paidShare: number | null; note: string };
};

export type AnalyticsFoldersResponse = {
  range: AnalyticsOverviewResponse["range"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  snapshot: { uniqueOwners: number; uniqueCollaborators: number; uniqueFolderUsers: number };
  engagement: {
    folderUsers: number | null;
    collaborators: number | null;
    others: number | null;
    folderPaidShare: number | null;
    collaboratorPaidShare: number | null;
    note: string;
  };
};

export type AnalyticsSharingResponse = {
  range: AnalyticsOverviewResponse["range"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  conversion: { viewsToPublicDownload: number | null; installerDownloads: number | null; note: string };
  series: { labels: string[]; shares: Array<number | null>; views: Array<number | null> };
};

export function fetchAnalyticsClips(token: string, search: string) {
  return adminFetch<AnalyticsClipsResponse>(`/v1/admin/analytics/clips${search}`, token);
}

export function fetchAnalyticsGames(token: string, search: string) {
  return adminFetch<AnalyticsGamesResponse>(`/v1/admin/analytics/games${search}`, token);
}

export function fetchAnalyticsFeatures(token: string, search: string) {
  return adminFetch<AnalyticsFeaturesResponse>(`/v1/admin/analytics/features${search}`, token);
}

export function fetchAnalyticsFolders(token: string, search: string) {
  return adminFetch<AnalyticsFoldersResponse>(`/v1/admin/analytics/folders${search}`, token);
}

export function fetchAnalyticsSharing(token: string, search: string) {
  return adminFetch<AnalyticsSharingResponse>(`/v1/admin/analytics/sharing${search}`, token);
}

export type AnalyticsRevenueResponse = {
  range: AnalyticsOverviewResponse["range"];
  comparisonRange: AnalyticsOverviewResponse["comparisonRange"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  snapshot: {
    paid: number;
    complimentary: number;
    premium: number;
    scheduledToCancel: number;
    pastDue: number;
    expired: number;
    cancelled: number;
  };
  metrics: AnalyticsKpi[];
  funnel: Array<{ name: string; count: number | null; availability: string }>;
  conversion: { signup7d: number | null; activation7d: number | null; activation30d: number | null; note: string };
  correlations: Array<{ key: string; label: string; users: number; paid: number; rate: number | null; note: string }>;
  reactivations: number | null;
  mrr: { estimatedCents: number; authoritativeCents: number | null; isEstimate: boolean; allAuthoritative: boolean };
  series: {
    labels: string[];
    paid: Array<number | null>;
    mrr: Array<number | null>;
    newPaid: Array<number | null>;
    cancelled: Array<number | null>;
  };
};

export type AnalyticsInfrastructureResponse = {
  range: AnalyticsOverviewResponse["range"];
  lastUpdated: string | null;
  freshness: "hourly";
  scope: string;
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  margin: {
    estimatedMrrCents: number;
    estimatedVariableInfraCents: number | null;
    estimatedGrossInfrastructureMarginCents: number | null;
    note: string;
  };
  segments: Array<{
    key: string;
    users: number;
    shareOfUsers: number | null;
    bytes: number;
    shareOfStorage: number | null;
  }>;
  topConsumers: Array<{
    userId: string;
    plan: string;
    storageBytes: number;
    readyClips: number;
    lastActiveAt: string | null;
    access: "paid" | "complimentary" | "free";
  }>;
  planEconomics: Array<{
    key: string;
    label: string;
    users: number;
    averageStorageBytes: number | null;
    averageClips: number | null;
    estimatedMonthlyCostCents: number | null;
  }>;
  assumptions: Array<{
    id: string;
    provider: string;
    metric: string;
    unit: string;
    rate: number;
    currency: string;
    effectiveFrom: string;
    notes: string | null;
  }>;
  forecast: {
    storageAdded30: number | null;
    storageAdded90: number | null;
    cost30Cents: number | null;
    cost90Cents: number | null;
    note: string;
  };
  series: { labels: string[]; added: Array<number | null>; total: Array<number | null> };
};

export function fetchAnalyticsRevenue(token: string, search: string) {
  return adminFetch<AnalyticsRevenueResponse>(`/v1/admin/analytics/revenue${search}`, token);
}

export function fetchAnalyticsInfrastructure(token: string, search: string) {
  return adminFetch<AnalyticsInfrastructureResponse>(`/v1/admin/analytics/infrastructure${search}`, token);
}

export type AnalyticsHealthResponse = {
  range: AnalyticsOverviewResponse["range"];
  comparisonRange: AnalyticsOverviewResponse["comparisonRange"];
  lastUpdated: string | null;
  freshness: "hourly";
  definitions: Record<string, string>;
  metrics: AnalyticsKpi[];
  attention: string[];
  insights: string[];
  releases: Array<{
    version: string;
    clipSaves: number;
    saveSuccess: number | null;
    uploads: number;
    uploadSuccess: number | null;
    renders: number;
    renderSuccess: number | null;
    errors: number;
    affectedUsers: number;
    potentialRegression: boolean;
    comparedTo: string | null;
  }>;
  platforms: Array<{
    platform: string;
    clipSaveSuccess: number | null;
    uploadSuccess: number | null;
    renderSuccess: number | null;
    errors: number;
  }>;
  errors: Array<{
    fingerprint: string;
    message: string;
    occurrences: number;
    affectedUsers: number;
    firstSeenAt: string;
    lastSeenAt: string;
    versions: string[];
    platforms: string[];
    status: string;
    href: string;
  }>;
  games: { note: string; rows: Array<{ slug: string; attempts: number; saveFailure: number | null }> };
  features: { note: string; rows: Array<{ key: string; label: string; failureRate: number | null }> };
  series: { labels: string[]; uploadFailed: Array<number | null>; saveFailed: Array<number | null>; errors: Array<number | null> };
};

export function fetchAnalyticsHealth(token: string, search: string) {
  return adminFetch<AnalyticsHealthResponse>(`/v1/admin/analytics/health${search}`, token);
}

export type AuditLogResponse = {
  range: { from: string; to: string };
  items: Array<{
    id: string;
    createdAt: string;
    actorUserId: string | null;
    actorType: string;
    action: string;
    actionLabel: string;
    targetType: string | null;
    targetId: string | null;
    targetHref: string | null;
    metadata: Record<string, unknown>;
    requestId: string | null;
  }>;
  nextCursor: string | null;
  limit: number;
};

export async function fetchAdminAudit(token: string, search: string) {
  return adminFetch<AuditLogResponse>(`/v1/admin/audit${search}`, token);
}

export type AnalyticsReportListItem = {
  id: string;
  reportType: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  periodEndInclusive: string;
  timezone: string;
  generatedAt: string;
  generatedBy: string | null;
  generatedByLabel: string;
  status: string;
  reportVersion: number;
  regeneratedFromId: string | null;
};

export type AnalyticsReportDetail = AnalyticsReportListItem & {
  dictionaryVersion: number | null;
  pdfStatus: string | null;
  summary: { executive?: string; attention?: string[] };
  snapshot: {
    meta: { title: string; label: string; from: string; to: string; timezone: string; generatedAt: string; reportVersion: number };
    comparison: AnalyticsComparisonRange;
    kpis: AnalyticsKpi[];
    downloads: {
      app: Record<string, number | null>;
      media: Record<string, number | null>;
      mediaTotal: number | null;
      series: { labels: string[]; installer: Array<number | null> };
      stats: { highest: { day: string; value: number } | null; lowest: { day: string; value: number } | null; average: number | null };
      tracking: { incomplete: boolean; trackedFrom: string | null; notice: string | null };
    };
    coverage: Array<{ key: string; label: string; status: string; note: string }>;
    sections: Record<string, { metrics?: AnalyticsKpi[]; games?: Array<{ slug: string; name: string; cloudClips: number }>; filters?: Array<{ id?: string; name?: string; applications?: number }>; cohorts?: Array<Record<string, unknown>>; tracking?: { notice?: string | null } }>;
  };
  insights: Array<{ text: string; metricIds: string[]; severity: string; confidence: string }>;
  recommendations: Array<{ title: string; category: string; text: string; confidence: string; basedOn: string[]; priority: string }>;
  availability: Record<string, string>;
};

export function fetchAnalyticsReports(token: string) {
  return adminFetch<{ items: AnalyticsReportListItem[]; nextCursor: string | null }>("/v1/admin/analytics/reports", token);
}

export function fetchAnalyticsReport(token: string, id: string) {
  return adminFetch<AnalyticsReportDetail>(`/v1/admin/analytics/reports/${id}`, token);
}

export async function createAnalyticsReport(
  token: string,
  body: { type: string; date?: string; from?: string; to?: string; timezone?: string },
) {
  const response = await fetch(apiUrl("/v1/admin/analytics/reports"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiJson<AnalyticsReportDetail>(response, "Could not generate report.");
}

export async function regenerateAnalyticsReport(token: string, id: string) {
  const response = await fetch(apiUrl(`/v1/admin/analytics/reports/${id}/regenerate`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return readApiJson<AnalyticsReportDetail>(response, "Could not regenerate report.");
}

export async function downloadAnalyticsReportPdf(token: string, id: string) {
  const response = await fetch(apiUrl(`/v1/admin/analytics/reports/${id}/pdf`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not download PDF.");
  return response.blob();
}

export async function downloadAnalyticsReportCsv(token: string, id: string, topic: string) {
  const response = await fetch(apiUrl(`/v1/admin/analytics/reports/${id}/export/${topic}`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not export CSV.");
  return response.blob();
}

export async function patchAnalyticsCostAssumption(
  token: string,
  body: { id: string; rate: number; currency?: string; notes?: string },
) {
  const response = await fetch(apiUrl("/v1/admin/analytics/cost-assumptions"), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiJson<{ id: string }>(response, "Could not update cost assumption.");
}
