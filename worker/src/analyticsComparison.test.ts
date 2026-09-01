import { describe, expect, it } from "vitest";
import { parseAdminAnalyticsQuery } from "./analyticsAdmin";
import {
  ANALYTICS_FIRST_DAY,
  COMPARISON_PARTIAL_REASON,
  COMPARISON_UNAVAILABLE_REASON,
  comparisonPeriodRange,
  comparisonQueryRange,
  cumulativeThrough,
  halfOpenUtcRange,
  intersectUtcRange,
  isValidHalfOpen,
  previousPeriod,
  resolveAnalyticsPreset,
  resolveComparisonPeriod,
} from "./analyticsDates";
import { healthInsights } from "./analyticsHealth";

const noonEt = new Date("2026-08-31T16:00:00.000Z");

describe("comparison range availability", () => {
  it("keeps a normal previous period unchanged when it is fully after first day", () => {
    const requested = previousPeriod("2026-08-28", "2026-09-01");
    expect(requested).toEqual({ from: "2026-08-24", to: "2026-08-28" });
    const comparison = resolveComparisonPeriod("2026-08-28", "2026-09-01");
    expect(comparison).toMatchObject({
      requested,
      from: "2026-08-24",
      to: "2026-08-28",
      available: true,
      complete: true,
      reason: null,
    });
    expect(comparisonQueryRange(comparison)).toEqual(requested);
    expect(comparisonPeriodRange(comparison)).toEqual(requested);
    expect(isValidHalfOpen(comparison.from, comparison.to)).toBe(true);
  });

  it("marks comparison unavailable when the previous window is entirely before first day", () => {
    const comparison = resolveComparisonPeriod("2026-08-21", "2026-09-01");
    expect(comparison.requested).toEqual({ from: "2026-08-10", to: "2026-08-21" });
    expect(comparison.available).toBe(false);
    expect(comparison.complete).toBe(false);
    expect(comparison.reason).toBe(COMPARISON_UNAVAILABLE_REASON);
    expect(comparisonQueryRange(comparison)).toBeNull();
    expect(comparisonPeriodRange(comparison)).toBeNull();
    expect(cumulativeThrough(comparison.requested.to)).toBeNull();
    expect(isValidHalfOpen(comparison.requested.from, comparison.requested.to)).toBe(true);
  });

  it("marks a partial previous overlap incomplete and does not invert [from, to)", () => {
    const comparison = resolveComparisonPeriod("2026-08-22", "2026-09-01");
    expect(comparison.requested).toEqual({ from: "2026-08-12", to: "2026-08-22" });
    expect(comparison).toMatchObject({
      from: ANALYTICS_FIRST_DAY,
      to: "2026-08-22",
      available: true,
      complete: false,
      reason: COMPARISON_PARTIAL_REASON,
    });
    expect(comparisonQueryRange(comparison)).toEqual({ from: "2026-08-21", to: "2026-08-22" });
    expect(comparisonPeriodRange(comparison)).toBeNull();
    expect(isValidHalfOpen(comparison.from, comparison.to)).toBe(true);
    expect(cumulativeThrough(comparison.requested.to)).toEqual({ from: ANALYTICS_FIRST_DAY, to: "2026-08-22" });
  });

  it("never returns an inverted query range", () => {
    expect(intersectUtcRange("2026-07-03", "2026-08-02")).toBeNull();
    expect(cumulativeThrough("2026-08-02")).toBeNull();
    expect(cumulativeThrough("2026-08-21")).toBeNull();
    expect(cumulativeThrough("2026-08-22")).toEqual({ from: ANALYTICS_FIRST_DAY, to: "2026-08-22" });
    expect(() => halfOpenUtcRange(ANALYTICS_FIRST_DAY, "2026-08-02")).toThrow(/to after from/);
  });

  it("keeps Today and Yesterday comparisons complete after first day", () => {
    const today = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=today&compare=1"),
      noonEt,
    );
    expect(today).toMatchObject({ from: "2026-08-31", to: "2026-09-01" });
    expect(today.comparison).toMatchObject({
      from: "2026-08-30",
      to: "2026-08-31",
      available: true,
      complete: true,
    });
    const yesterday = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=yesterday&compare=1"),
      noonEt,
    );
    expect(yesterday.comparison).toMatchObject({
      from: "2026-08-29",
      to: "2026-08-30",
      available: true,
      complete: true,
    });
  });

  it("does not 500 Last 30 Days with compare — previous is unavailable", () => {
    const parsed = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=last_30&compare=1"),
      noonEt,
    );
    expect(parsed.from).toBe("2026-08-02");
    expect(parsed.to).toBe("2026-09-01");
    expect(parsed.comparison?.available).toBe(false);
    expect(comparisonQueryRange(parsed.comparison)).toBeNull();
    expect(comparisonPeriodRange(parsed.comparison)).toBeNull();
    expect(cumulativeThrough(parsed.comparison!.requested.to)).toBeNull();
    expect(cumulativeThrough(parsed.to)).toEqual({ from: ANALYTICS_FIRST_DAY, to: "2026-09-01" });
  });

  it("makes All Time compare unavailable because the previous window ends at first day", () => {
    const allTime = resolveAnalyticsPreset("all_time", noonEt);
    expect(allTime).toEqual({ from: ANALYTICS_FIRST_DAY, to: "2026-09-01", preset: "all_time" });
    const parsed = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=all_time&compare=1"),
      noonEt,
    );
    expect(parsed.comparison?.available).toBe(false);
    expect(parsed.comparison?.reason).toBe(COMPARISON_UNAVAILABLE_REASON);
    expect(comparisonQueryRange(parsed.comparison)).toBeNull();
  });

  it("handles custom ranges: previous entirely before vs partial overlap", () => {
    const afterFirst = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=custom&from=2026-08-21&to=2026-08-31&compare=1"),
      noonEt,
    );
    expect(afterFirst).toMatchObject({ from: "2026-08-21", to: "2026-09-01" });
    expect(afterFirst.comparison?.available).toBe(false);

    const partial = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=custom&from=2026-08-25&to=2026-08-31&compare=1"),
      noonEt,
    );
    expect(partial.comparison).toMatchObject({
      from: ANALYTICS_FIRST_DAY,
      to: "2026-08-25",
      available: true,
      complete: false,
      reason: COMPARISON_PARTIAL_REASON,
    });
    expect(comparisonPeriodRange(partial.comparison)).toBeNull();
  });
});

describe("health insight wording", () => {
  it("never renders an error-group count as a user count", () => {
    const lines = healthInsights({
      uploadRate: null,
      previousUploadRate: null,
      versionLabel: null,
      previousVersionLabel: null,
      saveRegression: false,
      newErrorGroupCount: 6,
      affectedUserCount: 0,
      newErrorLabel: "Range must be [from, to) with to after from.",
    });
    expect(lines.join(" ")).toMatch(/6 new error groups were detected/);
    expect(lines.some((line) => /\d+\s+users/.test(line))).toBe(false);
    expect(lines.join(" ")).not.toMatch(/6 users/);
  });

  it("says users only when given a distinct affected-user count", () => {
    const lines = healthInsights({
      uploadRate: null,
      previousUploadRate: null,
      versionLabel: null,
      previousVersionLabel: null,
      saveRegression: false,
      newErrorGroupCount: 0,
      affectedUserCount: 28,
      newErrorLabel: "encoder",
    });
    expect(lines).toEqual(["28 users encountered the same new error: encoder."]);
  });
});
