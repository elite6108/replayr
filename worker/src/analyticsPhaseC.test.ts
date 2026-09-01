import { describe, expect, it } from "vitest";
import { parseAdminAnalyticsQuery } from "./analyticsAdmin";
import { DOWNLOAD_CLICK_EVENT, isServerAuthoritativeEvent } from "./analyticsDictionary";
import {
  ANALYTICS_DOWNLOADS_AVAILABLE_FROM,
  dateRangeToUtc,
  daysInRange,
  defaultGranularity,
  formatRangeLabel,
  inclusiveUtcRange,
  monthRange,
  percentChange,
  previousPeriod,
  resolveAnalyticsPreset,
  weekRange,
  zonedCalendarDay,
} from "./analyticsDates";
import {
  installerArtifact,
  isInstallerPayload,
  MAC_DMG_RELEASE_URL,
  macDmgReleaseAvailable,
  serveInstallerDownload,
  shouldCountInstallerDownload,
} from "./analyticsDownloads";

function req(method: string, extra: HeadersInit = {}) {
  return new Request("https://www.replayr.tv/releases/Replayr.exe", { method, headers: extra });
}

describe("download instrumentation", () => {
  it("keeps click and installer events separate and server-guards media counts", () => {
    expect(DOWNLOAD_CLICK_EVENT).toBe("app.download_clicked");
    expect(isServerAuthoritativeEvent("app.download_clicked")).toBe(false);
    expect(isServerAuthoritativeEvent("app.installer_downloaded")).toBe(true);
    expect(isServerAuthoritativeEvent("clip.downloaded")).toBe(true);
    expect(isServerAuthoritativeEvent("clip.public_downloaded")).toBe(true);
    expect(isServerAuthoritativeEvent("folder.public_downloaded")).toBe(true);
  });

  it("counts a successful installer GET 200", () => {
    expect(shouldCountInstallerDownload(req("GET"), new Response(null, { status: 200 }))).toBe(true);
  });

  it("does not count latest.json or non-installer paths", () => {
    expect(installerArtifact("/releases/latest.json")).toBeNull();
    expect(installerArtifact("/releases/Replayr.exe")?.platform).toBe("windows");
    expect(installerArtifact("/releases/Replayr.dmg")?.platform).toBe("macos");
  });

  it("does not count failed installer responses", () => {
    expect(shouldCountInstallerDownload(req("GET"), new Response(null, { status: 404 }))).toBe(false);
    expect(shouldCountInstallerDownload(req("GET"), new Response(null, { status: 500 }))).toBe(false);
    expect(shouldCountInstallerDownload(req("GET"), new Response(null, { status: 206 }))).toBe(false);
  });

  it("does not treat the marketing SPA as a DMG", () => {
    const html = new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(isInstallerPayload(html)).toBe(false);
    expect(shouldCountInstallerDownload(req("GET"), html)).toBe(false);
    const dmg = new Response(null, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(isInstallerPayload(dmg)).toBe(true);
    expect(shouldCountInstallerDownload(req("GET"), dmg)).toBe(true);
  });

  it("counts a 302 handoff to the published GitHub DMG", () => {
    expect(
      shouldCountInstallerDownload(
        req("GET"),
        new Response(null, { status: 302, headers: { location: MAC_DMG_RELEASE_URL } }),
      ),
    ).toBe(true);
  });

  it("returns 404 when the DMG is neither an asset nor a GitHub release", async () => {
    const response = await serveInstallerDownload(
      req("GET"),
      {} as never,
      "/releases/Replayr.dmg",
      async () =>
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      (value) => value,
      async () => new Response(null, { status: 404 }),
    );
    expect(response?.status).toBe(404);
    expect(await macDmgReleaseAvailable(async () => new Response(null, { status: 404 }))).toBe(false);
    expect(await macDmgReleaseAvailable(async () => new Response(null, { status: 200 }))).toBe(true);
  });

  it("redirects to the GitHub DMG when Workers Assets has no binary", async () => {
    const response = await serveInstallerDownload(
      new Request("https://www.replayr.tv/releases/Replayr.dmg", { method: "GET" }),
      {} as never,
      "/releases/Replayr.dmg",
      async () =>
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      (value) => value,
      async () => new Response(null, { status: 200 }),
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(MAC_DMG_RELEASE_URL);
  });

  it("does not count HEAD", () => {
    expect(shouldCountInstallerDownload(req("HEAD"), new Response(null, { status: 200 }))).toBe(false);
  });

  it("does not count resume Range requests", () => {
    expect(shouldCountInstallerDownload(req("GET", { range: "bytes=1024-" }), new Response(null, { status: 200 }))).toBe(
      false,
    );
    expect(shouldCountInstallerDownload(req("GET", { range: "bytes=0-1023" }), new Response(null, { status: 200 }))).toBe(
      true,
    );
  });
});

describe("admin date ranges", () => {
  const noonEt = new Date("2026-08-31T16:00:00.000Z"); // 12:00 America/New_York

  it("resolves Today and Yesterday in America/New_York", () => {
    expect(resolveAnalyticsPreset("today", noonEt)).toEqual({ from: "2026-08-31", to: "2026-09-01", preset: "today" });
    expect(resolveAnalyticsPreset("yesterday", noonEt)).toEqual({
      from: "2026-08-30",
      to: "2026-08-31",
      preset: "yesterday",
    });
  });

  it("uses Monday–Sunday weeks", () => {
    expect(weekRange("2026-08-31")).toEqual({ from: "2026-08-31", to: "2026-09-07" });
    expect(resolveAnalyticsPreset("this_week", noonEt)).toEqual({
      from: "2026-08-31",
      to: "2026-09-07",
      preset: "this_week",
    });
    expect(resolveAnalyticsPreset("last_week", noonEt)).toEqual({
      from: "2026-08-24",
      to: "2026-08-31",
      preset: "last_week",
    });
  });

  it("resolves last 7 days including today", () => {
    expect(resolveAnalyticsPreset("last_7", noonEt)).toEqual({ from: "2026-08-25", to: "2026-09-01", preset: "last_7" });
  });

  it("resolves a custom one-day range", () => {
    expect(resolveAnalyticsPreset("custom", noonEt, "America/New_York", { from: "2026-08-31", toInclusive: "2026-08-31" })).toEqual({
      from: "2026-08-31",
      to: "2026-09-01",
      preset: "custom",
    });
    expect(formatRangeLabel("2026-08-31", "2026-09-01")).toBe("August 31, 2026");
  });

  it("resolves a custom multi-day range", () => {
    const range = resolveAnalyticsPreset("custom", noonEt, "America/New_York", {
      from: "2026-08-04",
      toInclusive: "2026-08-19",
    });
    expect(range).toEqual({ from: "2026-08-04", to: "2026-08-20", preset: "custom" });
    expect(formatRangeLabel(range.from, range.to)).toBe("Aug 4–Aug 19");
  });

  it("handles month and year boundaries", () => {
    expect(monthRange("2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(resolveAnalyticsPreset("ytd", noonEt)).toEqual({ from: "2026-01-01", to: "2026-09-01", preset: "ytd" });
    expect(inclusiveUtcRange("2025-12-31", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2026-01-02" });
  });

  it("converts America/New_York calendar days through DST", () => {
    const spring = dateRangeToUtc("2026-03-08", "2026-03-09", "America/New_York");
    expect(zonedCalendarDay(spring.from, "America/New_York")).toBe("2026-03-08");
    expect(spring.to.getTime() - spring.from.getTime()).toBe(23 * 3600 * 1000);
    const fall = dateRangeToUtc("2026-11-01", "2026-11-02", "America/New_York");
    expect(fall.to.getTime() - fall.from.getTime()).toBe(25 * 3600 * 1000);
  });

  it("keeps [from, to) conversion exclusive at the end", () => {
    const range = dateRangeToUtc("2026-08-31", "2026-09-01", "America/New_York");
    expect(range.from.toISOString()).toBe("2026-08-31T04:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });
});

describe("dashboard math", () => {
  it("compares previous periods of equal length", () => {
    expect(previousPeriod("2026-08-31", "2026-09-01")).toEqual({ from: "2026-08-30", to: "2026-08-31" });
    expect(previousPeriod("2026-08-02", "2026-09-01")).toEqual({ from: "2026-07-03", to: "2026-08-02" });
    expect(previousPeriod("2026-08-10", "2026-08-21")).toEqual({ from: "2026-07-30", to: "2026-08-10" });
  });

  it("does not render Infinity when previous is zero", () => {
    expect(percentChange(12, 0)).toBe("new");
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(10, 5)).toBe(1);
  });

  it("does not plot pre-instrumentation download days as zero", () => {
    expect(ANALYTICS_DOWNLOADS_AVAILABLE_FROM).toBe("2026-08-31");
    const days = daysInRange("2026-08-01", "2026-09-02");
    const values = days.map((day) => (day < ANALYTICS_DOWNLOADS_AVAILABLE_FROM ? null : 0));
    expect(values[0]).toBeNull();
    expect(values.at(-1)).toBe(0);
  });

  it("does not sum storage EOD and keeps app/media separate", () => {
    const rows = [
      { total_storage_bytes_end_of_day: null, installer_downloads: 2, media_downloads_total: 5 },
      { total_storage_bytes_end_of_day: 100, installer_downloads: 3, media_downloads_total: 1 },
    ];
    const last = [...rows].reverse().find((row) => row.total_storage_bytes_end_of_day != null);
    expect(last?.total_storage_bytes_end_of_day).toBe(100);
    expect(rows.reduce((sum, row) => sum + (row.installer_downloads || 0), 0)).not.toBe(
      rows.reduce((sum, row) => sum + (row.media_downloads_total || 0), 0),
    );
  });

  it("parses admin query defaults and rejects bad custom ranges", () => {
    const parsed = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=last_30&compare=1"),
      new Date("2026-08-31T16:00:00.000Z"),
    );
    expect(parsed.from).toBe("2026-08-02");
    expect(parsed.to).toBe("2026-09-01");
    expect(parsed.granularity).toBe(defaultGranularity(parsed.from, parsed.to));
    expect(parsed.comparison).toMatchObject({
      requested: { from: "2026-07-03", to: "2026-08-02" },
      available: false,
      complete: false,
      reason: "No tracked data for previous period",
    });
    const oneDay = parseAdminAnalyticsQuery(
      new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=custom&from=2026-08-31&to=2026-08-31"),
    );
    expect(oneDay).toMatchObject({ from: "2026-08-31", to: "2026-09-01" });
    expect(() =>
      parseAdminAnalyticsQuery(
        new URL("https://www.replayr.tv/v1/admin/analytics/overview?range=custom&from=2026-08-31&to=2026-08-30"),
      ),
    ).toThrow();
  });
});
