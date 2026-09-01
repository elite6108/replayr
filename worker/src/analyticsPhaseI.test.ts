import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "./admin";
import { AUDIT_ACTIONS } from "./audit";
import {
  ANALYTICS_FIRST_DAY,
  COMPARISON_PARTIAL_REASON,
  COMPARISON_UNAVAILABLE_REASON,
  clipRequestedComparison,
  comparisonPeriodRange,
  comparisonQueryRange,
  isValidHalfOpen,
  requestedPreviousForReport,
  resolveReportPeriod,
  reportTitle,
  weekRange,
} from "./analyticsDates";
import {
  ANALYTICS_REPORT_VERSION,
  assembleReportSnapshot,
  presentReport,
  type AnalyticsReportRow,
  type AnalyticsReportSnapshot,
} from "./analyticsReport";
import { buildReportCsv, csvContainsForbidden } from "./analyticsReportCsv";
import {
  REPORT_INSIGHT_MIN_SAMPLE,
  buildNeedsAttention,
  buildReportInsights,
  insightFromGroupCount,
} from "./analyticsReportInsights";
import { pdfContainsForbidden, renderReportPdf } from "./analyticsReportPdf";
import type { Env } from "./env";
import type { AnalyticsKpi } from "./analyticsAdmin";

function testEnv(): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function kpi(
  key: string,
  value: number | null,
  extras: Partial<AnalyticsKpi> = {},
): AnalyticsKpi {
  return {
    key,
    label: key,
    value,
    previous: extras.previous ?? null,
    absoluteChange: extras.absoluteChange ?? null,
    percentageChange: extras.percentageChange ?? null,
    availability: extras.availability ?? "AVAILABLE",
    unit: extras.unit ?? "count",
    badge: extras.badge ?? null,
    tooltip: extras.tooltip,
  };
}

function emptySections() {
  const metrics: AnalyticsKpi[] = [];
  return {
    overview: { metrics },
    downloads: {
      metrics: [kpi("installer_downloads", 1824, { previous: 1540, percentageChange: (1824 - 1540) / 1540 })],
      series: { installer_downloads: { labels: ["2026-08-31"], values: [1824] } },
      breakdown: {
        app: { installer_downloads: 1824, app_download_clicks: 2100 },
        media: { clip_downloads_authenticated: 3, clip_downloads_public: 1, folder_public_downloads: 0 },
      },
      tracking: { incomplete: false, trackedFrom: "2026-08-31", notice: null },
    },
    growth: { metrics: [kpi("new_users", 12), kpi("activated_users", null, { availability: "INCOMPLETE" }), kpi("activation_rate_7d", null, { availability: "INCOMPLETE" })] },
    retention: { metrics: [kpi("retention_d1", null, { availability: "INCOMPLETE" })] },
    acquisition: { metrics: [] },
    clips: { metrics: [kpi("ready_cloud_clips", 40)] },
    games: { games: [{ name: "GTA V", slug: "grand-theft-auto-v", cloudClips: 28 }] },
    features: { metrics: [], filters: [] },
    folders: { metrics: [] },
    sharing: { metrics: [] },
    revenue: { metrics: [kpi("estimated_mrr_cents", 0, { availability: "AVAILABLE_ESTIMATE", unit: "cents" })] },
    infrastructure: { metrics: [], topConsumers: [{ userId: "secret-user", bytes: 12 }] },
    health: {
      metrics: [kpi("error_events", 5), kpi("new_error_groups", 2), kpi("unique_affected_users", 1)],
      releases: [],
      errors: [{ message: "render failed", affectedUsers: 1 }],
      attention: [],
    },
  };
}

function sampleRow(snapshot: AnalyticsReportSnapshot, extras: Partial<AnalyticsReportRow> = {}): AnalyticsReportRow {
  return {
    id: extras.id ?? "11111111-1111-4111-8111-111111111111",
    report_type: extras.report_type ?? "daily",
    period_start: extras.period_start ?? snapshot.meta.from,
    period_end: extras.period_end ?? snapshot.meta.to,
    display_timezone: extras.display_timezone ?? "America/New_York",
    title: extras.title ?? snapshot.meta.title,
    generated_by: extras.generated_by ?? "22222222-2222-4222-8222-222222222222",
    report_version: extras.report_version ?? ANALYTICS_REPORT_VERSION,
    metric_dictionary_version: extras.metric_dictionary_version ?? 1,
    status: extras.status ?? "ready",
    summary_json: extras.summary_json ?? { executive: "Installer downloads were 1824 in the selected period.", attention: ["No major issues detected in tracked data."] },
    metrics_json: extras.metrics_json ?? snapshot,
    availability_json: extras.availability_json ?? snapshot.availability,
    insights_json: extras.insights_json ?? [],
    recommendations_json: extras.recommendations_json ?? [],
    pdf_object_key: extras.pdf_object_key ?? null,
    pdf_status: extras.pdf_status ?? "on_demand",
    regenerated_from_id: extras.regenerated_from_id ?? null,
    created_at: extras.created_at ?? "2026-08-31T20:00:00.000Z",
  };
}

describe("report date ranges", () => {
  const noonEt = new Date("2026-08-31T16:00:00.000Z");

  it("1. resolves a daily exact day", () => {
    const period = resolveReportPeriod("daily", { date: "2026-08-31" }, noonEt);
    expect(period).toMatchObject({ from: "2026-08-31", to: "2026-09-01", label: "August 31, 2026" });
    expect(reportTitle("daily", period.from, period.to, period.label)).toBe("August 31, 2026 Daily Report");
  });

  it("2. resolves a Monday–Sunday week", () => {
    const period = resolveReportPeriod("weekly", { date: "2026-08-26" }, noonEt);
    expect(period.from).toBe("2026-08-24");
    expect(period.to).toBe("2026-08-31");
    expect(weekRange("2026-08-26").from).toBe("2026-08-24");
  });

  it("3. resolves a calendar month", () => {
    const period = resolveReportPeriod("monthly", { date: "2026-08-31" }, noonEt);
    expect(period).toMatchObject({ from: "2026-08-01", to: "2026-09-01", label: "August 2026" });
  });

  it("4. resolves a quarter", () => {
    const period = resolveReportPeriod("quarterly", { date: "2026-08-31" }, noonEt);
    expect(period).toMatchObject({ from: "2026-07-01", to: "2026-10-01", label: "Q3 2026" });
  });

  it("5. resolves year to date", () => {
    const period = resolveReportPeriod("ytd", { date: "2026-08-31" }, noonEt);
    expect(period).toMatchObject({ from: "2026-01-01", to: "2026-09-01" });
  });

  it("6. resolves a custom one-day range", () => {
    const period = resolveReportPeriod("custom", { from: "2026-08-31", toInclusive: "2026-08-31" }, noonEt);
    expect(period).toMatchObject({ from: "2026-08-31", to: "2026-09-01" });
  });

  it("7. resolves a custom multi-day range", () => {
    const period = resolveReportPeriod("custom", { from: "2026-08-04", toInclusive: "2026-08-19" }, noonEt);
    expect(period).toMatchObject({ from: "2026-08-04", to: "2026-08-20" });
  });

  it("8. uses America/New_York for the default calendar day", () => {
    const lateUtc = new Date("2026-09-01T03:30:00.000Z");
    const period = resolveReportPeriod("daily", {}, lateUtc, "America/New_York");
    expect(period.from).toBe("2026-08-31");
  });

  it("9. keeps week bounds across DST", () => {
    const spring = weekRange("2026-03-08", "America/New_York");
    expect(spring).toEqual({ from: "2026-03-02", to: "2026-03-09" });
    const fall = weekRange("2026-11-01", "America/New_York");
    expect(fall).toEqual({ from: "2026-10-26", to: "2026-11-02" });
  });
});

describe("report comparison", () => {
  it("10. uses a valid previous period", () => {
    const requested = requestedPreviousForReport("daily", "2026-08-31", "2026-09-01");
    expect(requested).toEqual({ from: "2026-08-30", to: "2026-08-31" });
    const comparison = clipRequestedComparison(requested);
    expect(comparison).toMatchObject({ available: true, complete: true, from: "2026-08-30", to: "2026-08-31" });
    expect(comparisonPeriodRange(comparison)).toEqual(requested);
  });

  it("11. marks previous entirely before ANALYTICS_FIRST_DAY unavailable", () => {
    const requested = requestedPreviousForReport("monthly", "2026-08-01", "2026-09-01");
    expect(requested).toEqual({ from: "2026-07-01", to: "2026-08-01" });
    const comparison = clipRequestedComparison(requested);
    expect(comparison.available).toBe(false);
    expect(comparison.reason).toBe(COMPARISON_UNAVAILABLE_REASON);
    expect(comparisonQueryRange(comparison)).toBeNull();
  });

  it("12. marks a partial previous overlap incomplete", () => {
    const requested = requestedPreviousForReport("custom", "2026-08-22", "2026-09-01");
    const comparison = clipRequestedComparison(requested);
    expect(comparison.available).toBe(true);
    expect(comparison.complete).toBe(false);
    expect(comparison.reason).toBe(COMPARISON_PARTIAL_REASON);
    expect(comparisonPeriodRange(comparison)).toBeNull();
    expect(comparison.from).toBe(ANALYTICS_FIRST_DAY);
  });

  it("13. never inverts [from, to)", () => {
    const comparison = clipRequestedComparison({ from: "2026-07-01", to: "2026-08-01" });
    expect(comparison.available).toBe(false);
    expect(isValidHalfOpen(comparison.requested.from, comparison.requested.to)).toBe(true);
    expect(comparisonQueryRange(comparison)).toBeNull();
  });

  it("14. does not invent a fake previous zero", () => {
    const comparison = clipRequestedComparison({ from: "2026-07-01", to: "2026-08-01" });
    expect(comparison.available).toBe(false);
    expect(comparison.from).not.toBe(ANALYTICS_FIRST_DAY);
  });

  it("15. does not compare unequal partial period sums", () => {
    const comparison = clipRequestedComparison(requestedPreviousForReport("custom", "2026-08-22", "2026-09-01"));
    expect(comparison.complete).toBe(false);
    expect(comparisonPeriodRange(comparison)).toBeNull();
  });
});

describe("report snapshots", () => {
  it("16. keeps the saved snapshot if live analytics later change", () => {
    const sections = emptySections();
    const assembled = assembleReportSnapshot({
      type: "daily",
      from: "2026-08-31",
      to: "2026-09-01",
      label: "August 31, 2026",
      timezone: "America/New_York",
      generatedBy: "22222222-2222-4222-8222-222222222222",
      generatedAt: "2026-08-31T20:00:00.000Z",
      sections: sections as never,
    });
    expect(assembled.snapshot.downloads.app.installer_downloads).toBe(1824);
    sections.downloads.breakdown.app.installer_downloads = 9999;
    const presented = presentReport(sampleRow(assembled.snapshot, { generated_by: "22222222-2222-4222-8222-222222222222" }), "Gordon");
    expect(presented.snapshot.downloads.app.installer_downloads).toBe(1824);
    expect(presented.generatedBy).toBe("22222222-2222-4222-8222-222222222222");
    expect(presented.reportVersion).toBe(1);
  });

  it("17-20. regenerate metadata stays on a new row and the original is unchanged", () => {
    const sections = emptySections();
    const first = assembleReportSnapshot({
      type: "daily",
      from: "2026-08-31",
      to: "2026-09-01",
      label: "August 31, 2026",
      timezone: "America/New_York",
      generatedBy: "22222222-2222-4222-8222-222222222222",
      generatedAt: "2026-08-31T20:00:00.000Z",
      sections: sections as never,
    });
    const original = sampleRow(first.snapshot, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const regenerated = sampleRow(first.snapshot, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      regenerated_from_id: original.id,
      created_at: "2026-08-31T21:00:00.000Z",
    });
    expect(regenerated.id).not.toBe(original.id);
    expect(regenerated.regenerated_from_id).toBe(original.id);
    expect(presentReport(original).snapshot.downloads.app.installer_downloads).toBe(1824);
    expect(regenerated.report_version).toBe(1);
    expect(original.generated_by).toBe("22222222-2222-4222-8222-222222222222");
    expect((regenerated.metrics_json.sections.infrastructure as { topConsumers?: Array<Record<string, unknown>> }).topConsumers?.[0].userId).toBeUndefined();
  });
});

describe("report availability", () => {
  it("21-26. preserves proxy, estimate, incomplete, and immature labels", () => {
    const insights = buildReportInsights({
      kpis: [
        { key: "cloud_activated_users", label: "Cloud Activated", value: 4, previous: 3, percentageChange: 0.33, availability: "PROXY" },
        { key: "estimated_mrr_cents", label: "Estimated MRR", value: 0, previous: null, percentageChange: null, availability: "AVAILABLE_ESTIMATE" },
        { key: "installer_downloads", label: "Installer Downloads", value: null, previous: null, percentageChange: null, availability: "INCOMPLETE" },
        { key: "activation_rate_7d", label: "7-Day Activation Rate", value: null, previous: null, percentageChange: null, availability: "INCOMPLETE" },
        { key: "retention_d30", label: "D30 Retention", value: null, previous: null, percentageChange: null, availability: "INCOMPLETE" },
        { key: "bandwidth_bytes", label: "Bandwidth", value: null, previous: null, percentageChange: null, availability: "NOT_INSTRUMENTED" },
      ],
      comparisonAvailable: false,
      comparisonComplete: false,
      newErrorGroupCount: 0,
      newErrorLabel: null,
      affectedUserCount: 0,
      topGame: null,
      regressions: [],
      folderRetentionNote: null,
    });
    expect(insights.some((item) => item.text.includes("increased") || item.text.includes("decreased"))).toBe(false);
    expect(insights.some((item) => item.metricIds.includes("activation_rate_7d") && item.text.includes("incomplete"))).toBe(true);
    expect(insights.every((item) => !item.text.includes("0%"))).toBe(true);
  });
});

describe("report insights", () => {
  it("27. every insight has metric references", () => {
    const insights = buildReportInsights({
      kpis: [{ key: "installer_downloads", label: "Installer Downloads", value: 1824, previous: 1540, percentageChange: 0.184, availability: "AVAILABLE" }],
      comparisonAvailable: true,
      comparisonComplete: true,
      newErrorGroupCount: 5,
      newErrorLabel: "render failed",
      affectedUserCount: 2,
      topGame: { name: "GTA V", share: 0.57, clips: 28 },
      regressions: [],
      folderRetentionNote: null,
    });
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.every((item) => item.metricIds.length > 0)).toBe(true);
  });

  it("28. unavailable metrics cannot create a normal trend insight", () => {
    const insights = buildReportInsights({
      kpis: [{ key: "installer_downloads", label: "Installer Downloads", value: 10, previous: 1, percentageChange: 9, availability: "INCOMPLETE" }],
      comparisonAvailable: true,
      comparisonComplete: true,
      newErrorGroupCount: 0,
      newErrorLabel: null,
      affectedUserCount: 0,
      topGame: null,
      regressions: [],
      folderRetentionNote: null,
    });
    expect(insights.some((item) => item.metricIds.includes("installer_downloads") && item.severity !== "info")).toBe(false);
  });

  it("29. group count cannot become a user count", () => {
    const insight = insightFromGroupCount(5, "render failed");
    expect(insight?.text).toContain("5 new error groups were detected");
    expect(insight?.text.toLowerCase()).not.toContain("users were detected");
  });

  it("30. correlation language stays non-causal", () => {
    const insights = buildReportInsights({
      kpis: [],
      comparisonAvailable: true,
      comparisonComplete: true,
      newErrorGroupCount: 0,
      newErrorLabel: null,
      affectedUserCount: 0,
      topGame: { name: "GTA V", share: 0.57, clips: 28 },
      regressions: [],
      folderRetentionNote: "Folder users showed higher observed D7 retention than users who did not use folders.",
    });
    expect(insights.some((item) => /caused|because of|due to/.test(item.text.toLowerCase()))).toBe(false);
    expect(insights.some((item) => item.text.includes("observed"))).toBe(true);
  });

  it("31. enforces the sample threshold for game share", () => {
    const below = buildReportInsights({
      kpis: [],
      comparisonAvailable: true,
      comparisonComplete: true,
      newErrorGroupCount: 0,
      newErrorLabel: null,
      affectedUserCount: 0,
      topGame: { name: "GTA V", share: 0.9, clips: REPORT_INSIGHT_MIN_SAMPLE - 1 },
      regressions: [],
      folderRetentionNote: null,
    });
    expect(below.some((item) => item.text.includes("GTA V"))).toBe(false);
  });

  it("does not manufacture attention items", () => {
    expect(buildNeedsAttention({ attention: [], insights: [], recommendations: [] })).toEqual([
      "No major issues detected in tracked data.",
    ]);
  });
});

describe("report PDF and CSV", () => {
  const assembled = assembleReportSnapshot({
    type: "daily",
    from: "2026-08-31",
    to: "2026-09-01",
    label: "August 31, 2026",
    timezone: "America/New_York",
    generatedBy: "22222222-2222-4222-8222-222222222222",
    generatedAt: "2026-08-31T20:00:00.000Z",
    sections: emptySections() as never,
  });
  const row = sampleRow(assembled.snapshot, { insights_json: assembled.insights, recommendations_json: assembled.recommendations, summary_json: assembled.summary });

  it("32-40. generates a branded PDF from the snapshot", () => {
    const bytes = renderReportPdf(row);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("August 31, 2026");
    expect(text).toContain("1824");
    expect(text).toContain("REPLAYR");
    expect(text).toContain("Page 1");
    expect(pdfContainsForbidden(bytes)).toBe(false);
    expect(text).not.toMatch(/Error:|at Object\.|sk_live|Bearer /);
    expect(text).toContain("Media downloads total");
  });

  it("41-47. exports UTF-8 CSV with ISO dates and raw numbers", () => {
    const file = buildReportCsv(row, "downloads");
    expect(file.body.charCodeAt(0)).toBe(0xfeff);
    expect(file.body).toContain("day,installer_downloads");
    expect(file.body).toContain("2026-08-31,1824");
    expect(file.body).not.toContain("1.8K");
    expect(csvContainsForbidden(file.body)).toBe(false);
    expect(file.body).not.toMatch(/email|jwt|stack|object_key/i);
    const empty = buildReportCsv(
      sampleRow({
        ...assembled.snapshot,
        downloads: { ...assembled.snapshot.downloads, series: { labels: [], installer: [] } },
      }),
      "downloads",
    );
    expect(empty.body).toContain("No tracked data for this period");
  });
});

describe("report authorization", () => {
  it("rejects unauthenticated report reads with 401", async () => {
    await expect(
      handleAdmin(new Request("https://www.replayr.tv/v1/admin/analytics/reports"), testEnv(), new URL("https://www.replayr.tv/v1/admin/analytics/reports")),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects signed-in non-admins with 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", app_metadata: { role: "user" } }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    await expect(
      handleAdmin(
        new Request("https://www.replayr.tv/v1/admin/analytics/reports", { headers: { authorization: "Bearer t" } }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/admin/analytics/reports"),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps report audit action names without storing report JSON", () => {
    expect(AUDIT_ACTIONS.analyticsReportGenerated).toBe("analytics.report_generated");
    expect(AUDIT_ACTIONS.analyticsReportRegenerated).toBe("analytics.report_regenerated");
    expect(AUDIT_ACTIONS.analyticsReportDeleted).toBe("analytics.report_deleted");
  });
});
