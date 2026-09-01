import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "./admin";
import { parseClientAnalyticsEvents } from "./analytics";
import { metricAvailability } from "./analyticsAvailability";
import { uploadSuccessRate } from "./analyticsAvailability";
import {
  classifyErrorStatus,
  failureRate,
  healthInsights,
  isPotentialRegression,
  successRate,
} from "./analyticsHealth";
import type { Env } from "./env";

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

describe("health rates", () => {
  it("uses saved / (saved + failed) and hides empty denominators", () => {
    expect(successRate(99, 1)).toBe(0.99);
    expect(successRate(0, 0)).toBeNull();
    expect(failureRate(99, 1)).toBeCloseTo(0.01);
    expect(successRate(null, 1)).toBeNull();
  });

  it("keeps retryable 502 out of the upload denominator", () => {
    expect(uploadSuccessRate(10, 2, 0)).toBe(10 / 12);
    expect(uploadSuccessRate(10, 2, 5)).toBe(10 / 12);
  });

  it("does not treat a 1-of-3 blip as a regression", () => {
    expect(isPotentialRegression({ failed: 1, total: 3 }, { failed: 0, total: 3 })).toBe(false);
    expect(
      isPotentialRegression({ failed: 30, total: 100 }, { failed: 10, total: 100 }),
    ).toBe(true);
    expect(
      isPotentialRegression({ failed: 11, total: 100 }, { failed: 10, total: 100 }),
    ).toBe(false);
  });

  it("groups versions and platforms without inventing iOS data", () => {
    expect(metricAvailability("clip_save_success_rate")).toBe("INCOMPLETE");
    expect(metricAvailability("render_success_rate")).toBe("INCOMPLETE");
    expect(metricAvailability("upload_success_rate")).toBe("AVAILABLE");
  });

  it("does not describe new error groups as users", () => {
    const lines = healthInsights({
      uploadRate: null,
      previousUploadRate: null,
      versionLabel: null,
      previousVersionLabel: null,
      saveRegression: false,
      newErrorGroupCount: 6,
      affectedUserCount: 0,
      newErrorLabel: "encoder",
    });
    expect(lines[0]).toBe("6 new error groups were detected: encoder.");
    expect(lines.some((line) => line.includes("users"))).toBe(false);
  });

  it("classifies error groups without stacks", () => {
    expect(
      classifyErrorStatus({
        firstSeenAt: "2026-08-31T00:00:00.000Z",
        lastSeenAt: "2026-08-31T12:00:00.000Z",
        resolvedAt: null,
        from: "2026-08-31",
        to: "2026-09-01",
      }),
    ).toBe("New");
    expect(
      classifyErrorStatus({
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-31T12:00:00.000Z",
        resolvedAt: "2026-08-31T10:00:00.000Z",
        from: "2026-08-31",
        to: "2026-09-01",
      }),
    ).toBe("Resolved");
  });

  it("allows client clip.render_failed and rejects non-admin health reads", async () => {
    expect(() => parseClientAnalyticsEvents({ eventName: "clip.render_failed", platform: "windows" })).not.toThrow();
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
        new Request("https://www.replayr.tv/v1/admin/analytics/health", { headers: { authorization: "Bearer t" } }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/admin/analytics/health"),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
