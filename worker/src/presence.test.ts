import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveTrafficGranularity } from "./analyticsTrafficAdmin";
import { permissionForAdminRoute } from "./staffPermissions";
import {
  inferLiveSurface,
  PRESENCE_ANON_LIMIT,
  sanitizePath,
  sanitizeVisitorKey,
  shouldSkipLiveTouch,
  handlePresence,
  hashVisitorKey,
} from "./presence";
import type { Env } from "./env";
import { clearRateLimitBuckets } from "./rateLimit";

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
  clearRateLimitBuckets();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live visitor skip list", () => {
  it("skips webhooks, health, ping, and live list", () => {
    expect(shouldSkipLiveTouch("/v1/billing/webhook")).toBe(true);
    expect(shouldSkipLiveTouch("/internal/webhooks/bunny")).toBe(true);
    expect(shouldSkipLiveTouch("/internal/bunny-source/abc")).toBe(true);
    expect(shouldSkipLiveTouch("/v1/presence/ping")).toBe(true);
    expect(shouldSkipLiveTouch("/v1/admin/analytics/live")).toBe(true);
    expect(shouldSkipLiveTouch("/v1/admin/analytics/traffic")).toBe(true);
    expect(shouldSkipLiveTouch("/v1/health")).toBe(true);
    expect(shouldSkipLiveTouch("/coming-soon")).toBe(true);
    expect(shouldSkipLiveTouch("/assets/index.js")).toBe(true);
  });

  it("touches API traffic including waitlist", () => {
    expect(shouldSkipLiveTouch("/v1/waitlist")).toBe(false);
    expect(shouldSkipLiveTouch("/v1/library")).toBe(false);
    expect(shouldSkipLiveTouch("/v1/admin/users")).toBe(true);
    expect(shouldSkipLiveTouch("/v1/staff/me")).toBe(true);
  });
});

describe("live visitor surfaces", () => {
  it("honors requested surface and infers admin/api/coming-soon", () => {
    expect(inferLiveSurface("/library", "desktop")).toBe("desktop");
    expect(inferLiveSurface("/v1/admin/users", null)).toBe("admin");
    expect(inferLiveSurface("/coming-soon", null)).toBe("coming-soon");
    expect(inferLiveSurface("/v1/library", null)).toBe("api");
    expect(inferLiveSurface("/explore", null)).toBe("web");
  });
});

describe("visitor key and path sanitizers", () => {
  it("accepts uuid-like keys and rejects junk", () => {
    expect(sanitizeVisitorKey("11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
    expect(sanitizeVisitorKey("short")).toBeNull();
    expect(sanitizeVisitorKey("bad key!!")).toBeNull();
  });

  it("requires a path that starts with slash", () => {
    expect(sanitizePath("/coming-soon")).toBe("/coming-soon");
    expect(sanitizePath("https://evil.example")).toBeNull();
  });

  it("hashes ip+ua stably", async () => {
    const a = await hashVisitorKey("1.1.1.1", "Mozilla");
    const b = await hashVisitorKey("1.1.1.1", "Mozilla");
    const c = await hashVisitorKey("8.8.8.8", "Mozilla");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBe(64);
  });
});

describe("presence ping", () => {
  it("accepts an anonymous coming-soon ping", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response("[]", { status: 200 });
      }),
    );
    const response = await handlePresence(
      new Request("https://replayr.tv/v1/presence/ping", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({
          path: "/coming-soon",
          anonymousId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          surface: "coming-soon",
        }),
      }),
      testEnv(),
      new URL("https://replayr.tv/v1/presence/ping"),
    );
    expect(response?.status).toBe(202);
    expect(calls.some((call) => call.url.includes("/rpc/upsert_live_visitor"))).toBe(true);
    const upsert = calls.find((call) => call.url.includes("/rpc/upsert_live_visitor"));
    expect(upsert?.body).toMatchObject({
      p_visitor_key: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      p_path: "/coming-soon",
      p_surface: "coming-soon",
      p_ip: "203.0.113.9",
    });
  });

  it("rate-limits anonymous pings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    const env = testEnv();
    const url = new URL("https://replayr.tv/v1/presence/ping");
    for (let i = 0; i < PRESENCE_ANON_LIMIT; i += 1) {
      const ok = await handlePresence(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.10" },
          body: JSON.stringify({ path: "/coming-soon", anonymousId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }),
        }),
        env,
        url,
      );
      expect(ok?.status).toBe(202);
    }
    await expect(
      handlePresence(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.10" },
          body: JSON.stringify({ path: "/coming-soon", anonymousId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }),
        }),
        env,
        url,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe("traffic granularity", () => {
  it("uses hour for one or two day ranges unless requested", () => {
    expect(resolveTrafficGranularity(null, "2026-09-17", "2026-09-18", "day")).toBe("hour");
    expect(resolveTrafficGranularity(null, "2026-09-01", "2026-09-30", "day")).toBe("day");
    expect(resolveTrafficGranularity("week", "2026-09-17", "2026-09-18", "day")).toBe("week");
  });
});

describe("admin live permission", () => {
  it("maps the live list to analytics.view", () => {
    expect(permissionForAdminRoute("GET", "/v1/admin/analytics/live")).toBe("analytics.view");
    expect(permissionForAdminRoute("GET", "/v1/admin/analytics/traffic")).toBe("analytics.view");
  });
});
