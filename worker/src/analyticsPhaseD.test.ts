import { describe, expect, it } from "vitest";
import {
  attributionCoverage,
  firstTouchLocked,
  installerSignupConversion,
  isSafeAnonymousId,
  normalizeAcquisitionSource,
  parseReplayrAnonymousId,
  sanitizeAttributionValue,
  sourceLabel,
} from "./analyticsAcquisition";
import {
  ANALYTICS_ACTIVITY_AVAILABLE_FROM,
  captureStartedCountsAsDau,
  cohortActivationRate,
  cohortKey,
  dauMauStickiness,
  exactDayAfter,
  formatDurationMs,
  isQualifyingActiveEvent,
  isWindowMature,
  neverMoveMilestoneLater,
  newVsReturning,
  percentile,
  replayEnabledCountsAsDau,
  resolveActivation,
  retainedOnExactDay,
  retentionDayMature,
  rollingUniqueUsers,
  shouldCountTowardDau,
  uniqueActiveUsers,
  uniqueActiveUsersInRange,
} from "./analyticsGrowth";

describe("active users", () => {
  it("counts one user with 20 events as one DAU", () => {
    const rows = Array.from({ length: 20 }, () => ({ day: "2026-08-31", user_id: "u1", environment: "production" }));
    expect(uniqueActiveUsers(rows, "2026-08-31")).toBe(1);
  });

  it("counts the same user once per day across three days", () => {
    const rows = ["2026-08-29", "2026-08-30", "2026-08-31"].map((day) => ({
      day,
      user_id: "u1",
      environment: "production",
    }));
    expect(uniqueActiveUsers(rows, "2026-08-29")).toBe(1);
    expect(uniqueActiveUsersInRange(rows, "2026-08-29", "2026-09-01")).toBe(1);
  });

  it("does not count anonymous or marketing events as DAU", () => {
    expect(shouldCountTowardDau({ eventName: "app.opened" })).toBe(false);
    expect(shouldCountTowardDau({ eventName: "app.download_clicked", userId: "u1" })).toBe(false);
    expect(shouldCountTowardDau({ eventName: "app.opened", userId: "u1" })).toBe(true);
    expect(shouldCountTowardDau({ eventName: "clip.saved", userId: "u1" })).toBe(true);
  });

  it("separates production from development", () => {
    expect(shouldCountTowardDau({ eventName: "app.opened", userId: "u1", environment: "development" })).toBe(false);
    expect(isQualifyingActiveEvent("app.opened")).toBe(true);
    expect(captureStartedCountsAsDau()).toBe(false);
    expect(replayEnabledCountsAsDau()).toBe(false);
  });

  it("treats WAU and MAU as unique users, not summed DAU", () => {
    const rows = [
      { day: "2026-08-31", user_id: "a", environment: "production" },
      { day: "2026-08-31", user_id: "b", environment: "production" },
      { day: "2026-09-01", user_id: "a", environment: "production" },
      { day: "2026-09-02", user_id: "a", environment: "production" },
    ];
    expect(uniqueActiveUsers(rows, "2026-08-31")).toBe(2);
    expect(rollingUniqueUsers(rows, "2026-09-02", 7)).toBe(2);
    expect(uniqueActiveUsersInRange(rows, "2026-08-31", "2026-09-03")).toBe(2);
  });

  it("handles DAU/MAU zero safely", () => {
    expect(dauMauStickiness(null, 10)).toBeNull();
    expect(dauMauStickiness(4, 0)).toBeNull();
    expect(dauMauStickiness(4100, 12300)).toBeCloseTo(4100 / 12300);
  });
});

describe("activation", () => {
  it("activates on first clip.saved", () => {
    expect(resolveActivation({ firstClipSavedAt: "2026-08-31T12:00:00.000Z" })).toEqual({
      activatedAt: "2026-08-31T12:00:00.000Z",
      activationSource: "local_clip",
      activationQuality: "exact",
    });
  });

  it("activates via cloud when upload is first", () => {
    expect(
      resolveActivation({
        firstCloudUploadAt: "2026-08-30T12:00:00.000Z",
        firstClipSavedAt: "2026-08-31T12:00:00.000Z",
      }),
    ).toEqual({
      activatedAt: "2026-08-30T12:00:00.000Z",
      activationSource: "cloud_clip",
      activationQuality: "exact",
    });
  });

  it("does not move activation later and marks historical cloud proxy", () => {
    expect(neverMoveMilestoneLater("2026-08-21T00:00:00.000Z", "2026-08-31T00:00:00.000Z")).toBe("2026-08-21T00:00:00.000Z");
    expect(resolveActivation({ firstCloudUploadAt: "2026-08-21T00:00:00.000Z" }).activationQuality).toBe("cloud_proxy");
  });

  it("computes 7-day cohort activation, not same-week mix", () => {
    const users = [
      { signup_at: "2026-08-01T00:00:00.000Z", activated_at: "2026-08-02T00:00:00.000Z" },
      { signup_at: "2026-08-01T00:00:00.000Z", activated_at: "2026-08-20T00:00:00.000Z" },
      { signup_at: "2026-08-01T00:00:00.000Z", activated_at: null },
    ];
    expect(cohortActivationRate(users, 7, "2026-08-20")).toBeCloseTo(1 / 3);
  });

  it("formats time-to-activation percentiles", () => {
    expect(percentile([1000, 2000, 3000, 4000], 0.5)).toBe(2500);
    expect(formatDurationMs(258_000)).toBe("4m 18s");
  });
});

describe("retention", () => {
  it("uses exact calendar day retention and leaves immature periods null", () => {
    expect(exactDayAfter("2026-08-31T15:00:00.000Z", 1)).toBe("2026-09-01");
    expect(retainedOnExactDay("2026-08-31T15:00:00.000Z", new Set(["2026-09-01"]), 1)).toBe(true);
    expect(retainedOnExactDay("2026-08-31T15:00:00.000Z", new Set(["2026-09-02"]), 1)).toBe(false);
    expect(retentionDayMature("2026-08-31", 7, "2026-09-07")).toBe(false);
    expect(retentionDayMature("2026-08-31", 7, "2026-09-08")).toBe(true);
    expect(retentionDayMature("2026-08-31", 30, "2026-09-15")).toBe(false);
  });

  it("buckets weekly cohorts Monday–Sunday", () => {
    expect(cohortKey("2026-08-31T12:00:00.000Z", "week")).toBe("2026-08-31");
    expect(cohortKey("2026-09-02T12:00:00.000Z", "week")).toBe("2026-08-31");
  });

  it("does not treat signup as new active", () => {
    const rows = [
      { day: "2026-08-20", user_id: "old", environment: "production" },
      { day: "2026-08-31", user_id: "old", environment: "production" },
      { day: "2026-08-31", user_id: "neu", environment: "production" },
    ];
    expect(newVsReturning(rows, "2026-08-31", "2026-09-01")).toEqual({ neu: 1, returning: 1 });
  });
});

describe("attribution", () => {
  it("locks first-touch and allows last-touch updates", () => {
    const first = { source: "discord" };
    expect(firstTouchLocked(first, { source: "x" })).toEqual(first);
    expect(normalizeAcquisitionSource({ source: "twitter" })).toBe("x");
    expect(normalizeAcquisitionSource({ landingPage: "/" })).toBe("direct");
    expect(normalizeAcquisitionSource({})).toBe("unknown");
    expect(sourceLabel("direct")).toBe("Direct");
    expect(sourceLabel("unknown")).toBe("Unknown");
  });

  it("sanitizes UTM, rejects fingerprint-like ids, and computes coverage", () => {
    expect(sanitizeAttributionValue("  launch\n  ", 80)).toBe("launch");
    expect(isSafeAnonymousId("short")).toBe(false);
    expect(isSafeAnonymousId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(attributionCoverage(620, 1000)).toBeCloseTo(0.62);
    expect(parseReplayrAnonymousId("replayr_aid=abc12345; other=1")).toBe("abc12345");
    const conversion = installerSignupConversion({ attributedSignups: 10, installerDownloads: 50, userLevelMatches: 0 });
    expect(conversion.label).toBe("period-level ratio");
    expect(isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7, "2026-09-05")).toBe(false);
    expect(isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7, "2026-09-06")).toBe(true);
  });
});
