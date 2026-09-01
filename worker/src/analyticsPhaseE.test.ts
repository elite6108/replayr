import { describe, expect, it } from "vitest";
import { metricAvailability } from "./analyticsAvailability";
import { isServerAuthoritativeEvent } from "./analyticsDictionary";
import { captureStartedCountsAsDau, isQualifyingActiveEvent } from "./analyticsGrowth";
import {
  adoptionRate,
  clipsPerActiveUser,
  CLIP_COUNT_BUCKETS,
  engagementRate,
  gameLabel,
  gameRetentionRows,
  histogram,
  isUsedFilter,
  paidShare,
  powerUserIds,
  repeatRate,
  shareOf,
  UNKNOWN_GAME_SLUG,
} from "./analyticsProduct";

describe("clip behavior", () => {
  it("does not invent clips per active user when DAU is missing", () => {
    expect(clipsPerActiveUser(10, null)).toBeNull();
    expect(clipsPerActiveUser(10, 0)).toBeNull();
    expect(clipsPerActiveUser(10, 5)).toBe(2);
  });

  it("buckets clip counts without treating zero as a creator", () => {
    expect(histogram([1, 1, 4, 20], [...CLIP_COUNT_BUCKETS])).toEqual([
      { key: "1", count: 2 },
      { key: "2-3", count: 0 },
      { key: "4-7", count: 1 },
      { key: "8-15", count: 0 },
      { key: "16+", count: 1 },
    ]);
  });
});

describe("games", () => {
  it("keeps Unknown separate from named games", () => {
    expect(gameLabel(UNKNOWN_GAME_SLUG)).toBe("Unknown");
    expect(gameLabel("fortnite", "Fortnite")).toBe("Fortnite");
  });

  it("uses exact-day game community retention and leaves immature D7 null", () => {
    const rows = gameRetentionRows(
      [
        { user_id: "a", game_slug: "fortnite", first_ready_at: "2026-08-20T12:00:00.000Z" },
        { user_id: "b", game_slug: "fortnite", first_ready_at: "2026-08-28T12:00:00.000Z" },
      ],
      new Map([
        ["a", new Set(["2026-08-27"])],
        ["b", new Set(["2026-08-29"])],
      ]),
      "2026-08-31",
      7,
    );
    const fortnite = rows.find((row) => row.game_slug === "fortnite");
    expect(fortnite?.users).toBe(2);
    expect(fortnite?.eligible).toBe(1);
    expect(fortnite?.rate).toBe(1);
  });
});

describe("filters and features", () => {
  it("does not treat none as a used filter", () => {
    expect(isUsedFilter("none")).toBe(false);
    expect(isUsedFilter("unknown")).toBe(false);
    expect(isUsedFilter("bodycam")).toBe(true);
  });

  it("computes adoption and repeat against unique users", () => {
    expect(adoptionRate(4, 10)).toBe(0.4);
    expect(adoptionRate(4, null)).toBeNull();
    expect(repeatRate(2, 8)).toBe(0.25);
    expect(repeatRate(1, 0)).toBeNull();
  });

  it("keeps capture out of DAU while still allowing adoption", () => {
    expect(isQualifyingActiveEvent("capture.started")).toBe(false);
    expect(captureStartedCountsAsDau()).toBe(false);
    expect(isQualifyingActiveEvent("visual.filter_selected")).toBe(false);
  });
});

describe("folders and paid correlation", () => {
  it("compares folder-user engagement without inventing zeros", () => {
    const activity = [
      { day: "2026-08-31", user_id: "owner", environment: "production" },
      { day: "2026-08-31", user_id: "other", environment: "production" },
    ];
    expect(engagementRate(["owner", "idle"], activity, "2026-08-31", "2026-09-01")).toBe(0.5);
    expect(engagementRate([], activity, "2026-08-31", "2026-09-01")).toBeNull();
  });

  it("reports paid share as a product correlation", () => {
    expect(paidShare(["a", "b", "c"], new Set(["b"]))).toBeCloseTo(1 / 3);
    expect(paidShare([], new Set(["b"]))).toBeNull();
  });
});

describe("sharing", () => {
  it("does not claim share-to-installer conversion", () => {
    expect(metricAvailability("share_to_download")).toBe("NOT_INSTRUMENTED");
    expect(shareOf(2, 10)).toBe(0.2);
    expect(shareOf(2, 0)).toBeNull();
  });

  it("keeps share events client-writable and play/add server-authoritative", () => {
    expect(isServerAuthoritativeEvent("clip.shared")).toBe(false);
    expect(isServerAuthoritativeEvent("clip.played")).toBe(true);
    expect(isServerAuthoritativeEvent("folder.clip_added")).toBe(true);
  });
});

describe("power users", () => {
  it("takes the top decile and keeps ties at the cutoff", () => {
    const users = Array.from({ length: 10 }, (_, index) => ({ user_id: `u${index}`, count: 10 - index }));
    expect(powerUserIds(users)).toEqual(["u0"]);
    expect(powerUserIds([
      { user_id: "a", count: 5 },
      { user_id: "b", count: 5 },
      { user_id: "c", count: 1 },
    ])).toEqual(["a", "b"]);
    expect(powerUserIds([])).toEqual([]);
  });
});
