import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_METRIC_CATALOG, isDisplayableMetric, metricAvailability, uploadSuccessRate } from "./analyticsAvailability";
import {
  addUtcDays,
  ANALYTICS_RECENT_ROLLUP_DAYS,
  assertBackfillRange,
  daysInRange,
  halfOpenUtcRange,
  inclusiveUtcRange,
  recentRollupRange,
  utcDay,
  utcMonthRange,
  utcWeekRange,
  utcWeekStart,
} from "./analyticsDates";
import { rebuildAnalyticsDaily, runRecentAnalyticsRollup } from "./analyticsRollup";
import type { Env } from "./env";
import { HttpError } from "./http";

const here = dirname(fileURLToPath(import.meta.url));

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("analytics date helpers", () => {
  it("uses UTC day boundaries, not local midnight", () => {
    expect(utcDay(new Date("2026-08-31T23:30:00.000Z"))).toBe("2026-08-31");
    expect(utcDay(new Date("2026-08-31T23:30:00.000-04:00"))).toBe("2026-09-01");
    expect(utcDay(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  it("uses half-open [from, to) ranges", () => {
    expect(halfOpenUtcRange("2026-08-01", "2026-09-01")).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(inclusiveUtcRange("2026-08-01", "2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(daysInRange("2026-08-30", "2026-09-01")).toEqual(["2026-08-30", "2026-08-31"]);
    expect(() => halfOpenUtcRange("2026-08-31", "2026-08-31")).toThrow(/to after from/);
  });

  it("defines weeks as Monday–Sunday", () => {
    expect(utcWeekStart("2026-08-31")).toBe("2026-08-31");
    expect(utcWeekStart("2026-09-02")).toBe("2026-08-31");
    expect(utcWeekStart("2026-09-06")).toBe("2026-08-31");
    expect(utcWeekRange("2026-09-02")).toEqual({ from: "2026-08-31", to: "2026-09-07" });
  });

  it("defines UTC months as [first, next first)", () => {
    expect(utcMonthRange("2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-09-01" });
  });

  it("recalculates only today plus the previous two UTC days", () => {
    const range = recentRollupRange(new Date("2026-08-31T15:00:00.000Z"));
    expect(ANALYTICS_RECENT_ROLLUP_DAYS).toBe(3);
    expect(range).toEqual({ from: "2026-08-29", to: "2026-09-01" });
    expect(daysInRange(range.from, range.to)).toHaveLength(3);
    expect(range.from > "2026-01-01").toBe(true);
  });

  it("caps manual backfill and accepts a requested range", () => {
    expect(assertBackfillRange("2026-01-01", "2026-02-01")).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(() => assertBackfillRange("2025-01-01", addUtcDays("2025-01-01", 367))).toThrow(/366/);
  });
});

describe("metric availability", () => {
  it("keeps unavailable metrics unavailable instead of a displayable zero", () => {
    expect(metricAvailability("active_users")).toBe("INCOMPLETE");
    expect(metricAvailability("activated_users")).toBe("INCOMPLETE");
    expect(metricAvailability("app_download_clicks")).toBe("AVAILABLE");
    expect(metricAvailability("installer_downloads")).toBe("AVAILABLE");
    expect(isDisplayableMetric("active_users")).toBe(false);
    expect(isDisplayableMetric("installer_downloads")).toBe(true);
    expect(isDisplayableMetric("new_users")).toBe(true);
    expect(isDisplayableMetric("cloud_activated_users")).toBe(true);
    expect(isDisplayableMetric("estimated_mrr_cents")).toBe(true);
  });

  it("keeps download categories separate", () => {
    const keys = ANALYTICS_METRIC_CATALOG.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining([
      "app_download_clicks",
      "installer_downloads",
      "clip_downloads_authenticated",
      "clip_downloads_public",
      "folder_public_downloads",
    ]));
    expect(keys).not.toContain("downloads");
  });

  it("flags estimated MRR as an estimate", () => {
    expect(metricAvailability("estimated_mrr_cents")).toBe("AVAILABLE_ESTIMATE");
  });
});

describe("upload success rate", () => {
  it("uses completed / (completed + failed) terminal outcomes", () => {
    expect(uploadSuccessRate(7, 3)).toBe(0.7);
    expect(uploadSuccessRate(0, 0)).toBeNull();
  });

  it("does not treat leftover aborted session rows as extra failures", () => {
    expect(uploadSuccessRate(10, 2, 2)).toBe(10 / 12);
  });

  it("does not count a retryable multipart 502 as clip.upload_failed", () => {
    const src = readFileSync(join(here, "index.ts"), "utf8");
    const finish = src.match(/if \(!done\.ok\) \{\s*return json\(\{ error: `Could not finish multipart upload[\s\S]*?\}, 502\);/);
    expect(finish?.[0]).toContain("502");
    expect(finish?.[0]).not.toContain("observeServerAnalytics");
    expect(finish?.[0]).not.toContain("uploadFailed");
    expect(src).toContain('status: "failed"');
    expect(src).toContain("SERVER_ANALYTICS_EVENTS.uploadFailed");
  });
});

describe("aggregation job", () => {
  it("can run twice without appending — both calls upsert the same [from, to)", async () => {
    const fetchMock = vi.fn(async () => new Response("3", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await runRecentAnalyticsRollup(testEnv(), new Date("2026-08-31T15:00:00.000Z"));
    const second = await runRecentAnalyticsRollup(testEnv(), new Date("2026-08-31T15:00:00.000Z"));
    expect(first).toEqual(second);
    expect(first).toEqual({ from: "2026-08-29", to: "2026-09-01", days: 3 });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(bodies).toEqual([
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
      { p_from: "2026-08-29", p_to: "2026-09-01" },
    ]);
    expect(urls.filter((url) => url.includes("rollup_analytics_days"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("rollup_analytics_growth_days"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("rollup_analytics_product_days"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("rollup_analytics_revenue_days"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("rollup_analytics_health_days"))).toHaveLength(2);
  });

  it("does not send older history on the hourly window", async () => {
    const fetchMock = vi.fn(async () => new Response("3", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runRecentAnalyticsRollup(testEnv(), new Date("2026-08-31T15:00:00.000Z"));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      p_from: string;
      p_to: string;
    };
    expect(body.p_from).toBe("2026-08-29");
    expect(body.p_from >= "2026-08-01").toBe(true);
  });

  it("manual backfill uses the requested range", async () => {
    const fetchMock = vi.fn(async () => new Response("10", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await rebuildAnalyticsDaily(testEnv(), "2026-08-01", "2026-08-11");
    expect(result).toEqual({ from: "2026-08-01", to: "2026-08-11", days: 10 });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      p_from: "2026-08-01",
      p_to: "2026-08-11",
    });
  });

  it("rejects an unrestricted backfill range", async () => {
    await expect(rebuildAnalyticsDaily(testEnv(), "2024-01-01", "2026-08-31")).rejects.toThrow(/366/);
  });

  it("surfaces rollup RPC failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(runRecentAnalyticsRollup(testEnv())).rejects.toBeInstanceOf(HttpError);
  });
});
