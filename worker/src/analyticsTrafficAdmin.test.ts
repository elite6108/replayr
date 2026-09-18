import { describe, expect, it } from "vitest";
import { alignTrafficSeries, unwrapTrafficReport } from "./analyticsTrafficAdmin";

describe("unwrapTrafficReport", () => {
  it("reads a wrapped PostgREST jsonb payload", () => {
    const inner = {
      totals: { uniqueVisitors: 7, signedIn: 1, pings: 99 },
      series: [{ bucketStart: "2026-09-18T01:00:00+00:00", uniqueVisitors: 6, signedIn: 1, pings: 95 }],
    };
    expect(unwrapTrafficReport([{ visitor_traffic_report: inner }])).toMatchObject(inner);
  });
});

describe("alignTrafficSeries", () => {
  it("plots the current hour even when timestamps include an offset", () => {
    const series = alignTrafficSeries(
      "2026-09-17",
      "2026-09-18",
      "hour",
      "America/New_York",
      [
        {
          bucketStart: "2026-09-18T01:00:00+00:00",
          uniqueVisitors: 6,
          signedIn: 1,
          pings: 95,
        },
      ],
    );
    expect(series.unique.some((value) => value === 6)).toBe(true);
    expect(series.pings.some((value) => value === 95)).toBe(true);
  });

  it("falls back to raw buckets when none of the expected slots match", () => {
    const series = alignTrafficSeries("2026-08-01", "2026-08-03", "day", "America/New_York", [
      {
        bucketStart: "2026-09-18T01:00:00+00:00",
        uniqueVisitors: 4,
        signedIn: 0,
        pings: 12,
      },
    ]);
    expect(series.labels.length).toBe(1);
    expect(series.unique).toEqual([4]);
  });
});
