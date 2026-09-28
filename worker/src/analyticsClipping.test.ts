import { describe, expect, it } from "vitest";
import { clippingUsageFromActivity, uniqueLocalClippersByDay } from "./analyticsClipping";

describe("clippingUsageFromActivity", () => {
  it("splits local-only, cloud, and conversion", () => {
    const usage = clippingUsageFromActivity([
      { day: "2026-09-01", user_id: "a", environment: "production", clip_saved: true },
      { day: "2026-09-02", user_id: "a", environment: "production", clip_uploaded: true },
      { day: "2026-09-01", user_id: "b", environment: "production", clip_saved: true },
      { day: "2026-09-01", user_id: "c", environment: "production", clip_uploaded: true },
    ]);
    expect(usage.localClippers).toBe(2);
    expect(usage.cloudClippers).toBe(2);
    expect(usage.localOnlyClippers).toBe(1);
    expect(usage.localThenCloud).toBe(1);
    expect(usage.conversion).toBe(0.5);
  });
});

describe("uniqueLocalClippersByDay", () => {
  it("counts distinct users per day", () => {
    const series = uniqueLocalClippersByDay(
      [
        { day: "2026-09-01", user_id: "a", environment: "production", clip_saved: true },
        { day: "2026-09-01", user_id: "a", environment: "production", clip_saved: true },
        { day: "2026-09-01", user_id: "b", environment: "production", clip_saved: true },
        { day: "2026-09-02", user_id: "b", environment: "production", clip_saved: true },
      ],
      ["2026-09-01", "2026-09-02", "2026-09-03"],
    );
    expect(series).toEqual([2, 1, 0]);
  });
});
