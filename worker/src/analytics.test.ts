import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_ANON_LIMIT,
  ANALYTICS_MAX_PROPERTIES_BYTES,
  coarseCountry,
  ingestClientAnalytics,
  insertAnalyticsEvent,
  observeServerAnalytics,
  parseClientAnalyticsEvents,
  resolveAnalyticsEnvironment,
  sanitizeAnalyticsProperties,
  SERVER_ANALYTICS_EVENTS,
  serverIdempotencyKey,
  toAnalyticsRow,
} from "./analytics";
import { isAuthoritativeFinancialEvent, isServerAuthoritativeEvent } from "./analyticsDictionary";
import type { Env } from "./env";
import { HttpError } from "./http";
import { clearRateLimitBuckets } from "./rateLimit";

const CLIP_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

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
    ANALYTICS_SUBJECT_KEY: "test-analytics-subject-key-at-least-32-characters",
    ANALYTICS_SUBJECT_KEY_VERSION: "1",
    ...overrides,
  };
}

function ingestRequest(body: unknown, ip = "203.0.113.10", token?: string): Request {
  return new Request("https://www.replayr.tv/v1/analytics/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "cf-ipcountry": "US",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function mockIngest(inserted = true) {
  return vi.fn(async () =>
    new Response(JSON.stringify([{ inserted, event_id: CLIP_ID }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  clearRateLimitBuckets();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dictionary", () => {
  it("treats subscription and revenue names as financial", () => {
    expect(isAuthoritativeFinancialEvent("subscription.started")).toBe(true);
    expect(isAuthoritativeFinancialEvent("revenue.mrr")).toBe(true);
    expect(isAuthoritativeFinancialEvent("app.opened")).toBe(false);
  });

  it("reserves Phase A server events", () => {
    expect(isServerAuthoritativeEvent("clip.upload_completed")).toBe(true);
    expect(isServerAuthoritativeEvent("folder.created")).toBe(true);
    expect(isServerAuthoritativeEvent("clip.saved")).toBe(false);
    expect(isServerAuthoritativeEvent("app.installer_downloaded")).toBe(true);
    expect(isServerAuthoritativeEvent("clip.downloaded")).toBe(true);
    expect(isServerAuthoritativeEvent("app.download_clicked")).toBe(false);
    expect(serverIdempotencyKey(SERVER_ANALYTICS_EVENTS.uploadCompleted, CLIP_ID)).toBe(
      `clip.upload_completed:${CLIP_ID}`,
    );
  });
});

describe("parseClientAnalyticsEvents", () => {
  it("accepts a normal product event", () => {
    const [event] = parseClientAnalyticsEvents({
      eventName: "screen.viewed",
      platform: "windows",
      environment: "production",
      properties: { screen: "home" },
    });
    expect(event.eventName).toBe("screen.viewed");
    expect(event.properties).toEqual({ screen: "home" });
  });

  it("rejects a malformed payload", () => {
    expect(() => parseClientAnalyticsEvents(null)).toThrow(HttpError);
    expect(() => parseClientAnalyticsEvents({})).toThrow(/eventName/);
    expect(() => parseClientAnalyticsEvents({ eventName: "OPENED" })).toThrow(/invalid/);
    expect(() => parseClientAnalyticsEvents({ eventName: "custom.user_secret" })).toThrow(/not allowed/);
  });

  it("keeps only allowlisted count-only properties", () => {
    const [event] = parseClientAnalyticsEvents({
      eventName: "clip.shared",
      properties: { body: "private", recipient_id: USER_ID, channel: "dm" },
    });
    expect(event.properties).toEqual({ channel: "dm" });
    const [screen] = parseClientAnalyticsEvents({
      eventName: "screen.viewed",
      properties: { screen: "library", path: "/c/private-slug" },
    });
    expect(screen.properties).toEqual({ screen: "library" });
  });

  it("rejects oversized properties", () => {
    expect(() =>
      sanitizeAnalyticsProperties({ note: "x".repeat(ANALYTICS_MAX_PROPERTIES_BYTES + 10) }),
    ).toThrow(/too large/);
  });

  it("rejects client writes of subscription and server-authoritative events", () => {
    expect(() => parseClientAnalyticsEvents({ eventName: "subscription.started" })).toThrow(
      /Replayr servers/,
    );
    expect(() => parseClientAnalyticsEvents({ eventName: "clip.upload_completed" })).toThrow(
      /Replayr servers/,
    );
    expect(() => parseClientAnalyticsEvents({ eventName: "auth.signup_completed" })).toThrow(
      /Replayr servers/,
    );
    expect(() => parseClientAnalyticsEvents({ eventName: "clip.downloaded" })).toThrow(/Replayr servers/);
    expect(() => parseClientAnalyticsEvents({ eventName: "clip.played" })).toThrow(/Replayr servers/);
    expect(() => parseClientAnalyticsEvents({ eventName: "folder.clip_added" })).toThrow(/Replayr servers/);
    expect(() => parseClientAnalyticsEvents({ eventName: "app.download_clicked" })).not.toThrow();
    expect(() => parseClientAnalyticsEvents({ eventName: "clip.shared" })).not.toThrow();
    expect(() => parseClientAnalyticsEvents({ eventName: "visual.filter_selected" })).not.toThrow();
  });

  it("keeps production and development distinct", () => {
    const prod = toAnalyticsRow(parseClientAnalyticsEvents({ eventName: "app.opened", environment: "production" })[0], {
      environment: "production",
    });
    const dev = toAnalyticsRow(parseClientAnalyticsEvents({ eventName: "app.opened", environment: "development" })[0], {
      environment: "development",
    });
    expect(prod.environment).toBe("production");
    expect(dev.environment).toBe("development");
    expect(prod.environment).not.toBe(dev.environment);
    expect(resolveAnalyticsEnvironment(testEnv({ PUBLIC_APP_URL: "http://127.0.0.1:8787" }))).toBe(
      "development",
    );
  });
});

describe("ingestClientAnalytics", () => {
  it("accepts a consented authenticated analytics event without storing a user id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: USER_ID, email: "player@example.com" }), { status: 200 });
      }
      if (url.includes("/user_analytics_preferences")) {
        return new Response(JSON.stringify([{ consent: "allowed" }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ inserted: true, event_id: CLIP_ID }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await ingestClientAnalytics(
      ingestRequest({ eventName: "app.opened", platform: "web", environment: "production" }, "203.0.113.10", "token"),
      testEnv(),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: number };
    expect(body.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      p_event_name: string;
      p_environment: string;
      p_user_id: string | null;
      p_subject_id: string | null;
    };
    expect(sent.p_event_name).toBe("app.opened");
    expect(sent.p_environment).toBe("production");
    expect(sent.p_user_id).toBeNull();
    expect(sent.p_subject_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not ingest anonymous journey events", async () => {
    const fetchMock = mockIngest(true);
    vi.stubGlobal("fetch", fetchMock);
    const response = await ingestClientAnalytics(
      ingestRequest({ eventName: "app.opened", idempotencyKey: "app.opened:session-1" }),
      testEnv(),
    );
    expect(((await response.json()) as { accepted: number }).accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits anonymous ingest", async () => {
    vi.stubGlobal("fetch", mockIngest(true));
    const ip = "198.51.100.9";
    for (let i = 0; i < ANALYTICS_ANON_LIMIT; i += 1) {
      const response = await ingestClientAnalytics(ingestRequest({ eventName: "app.opened" }, ip), testEnv());
      expect(response.status).toBe(202);
    }
    await expect(ingestClientAnalytics(ingestRequest({ eventName: "app.opened" }, ip), testEnv())).rejects.toMatchObject({
      status: 429,
    });
  });

  it("drops anonymous payloads before inspecting restricted event names", async () => {
    const fetchMock = mockIngest(true);
    vi.stubGlobal("fetch", fetchMock);
    const response = await ingestClientAnalytics(
      ingestRequest({ eventName: "subscription.cancelled" }),
      testEnv(),
    );
    expect(response.status).toBe(202);
    expect(((await response.json()) as { accepted: number }).accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("server authoritative events", () => {
  it("inserts clip.upload_completed with a stable idempotency key", async () => {
    const fetchMock = mockIngest(true);
    vi.stubGlobal("fetch", fetchMock);
    const result = await insertAnalyticsEvent(
      testEnv(),
      toAnalyticsRow(
        {
          eventName: SERVER_ANALYTICS_EVENTS.uploadCompleted,
          idempotencyKey: serverIdempotencyKey(SERVER_ANALYTICS_EVENTS.uploadCompleted, CLIP_ID),
          platform: "server",
        },
        { userId: USER_ID, environment: "production" },
      ),
    );
    expect(result.inserted).toBe(true);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      p_event_name: string;
      p_idempotency_key: string;
      p_user_id: string | null;
    };
    expect(sent.p_event_name).toBe("clip.upload_completed");
    expect(sent.p_idempotency_key).toMatch(/^clip\.upload_completed:[0-9a-f]{64}$/);
    expect(sent.p_idempotency_key).not.toContain(CLIP_ID);
    expect(sent.p_user_id).toBeNull();
  });

  it("observes without throwing when ingest fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network"))));
    expect(() =>
      observeServerAnalytics(testEnv(), SERVER_ANALYTICS_EVENTS.folderCreated, {
        userId: USER_ID,
        entityId: CLIP_ID,
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("reads coarse country only from CF-IPCountry", () => {
    const request = new Request("https://www.replayr.tv/", {
      headers: { "cf-ipcountry": "ca", "cf-connecting-ip": "203.0.113.1" },
    });
    expect(coarseCountry(request)).toBe("CA");
    expect(coarseCountry(new Request("https://www.replayr.tv/"))).toBeNull();
  });
});

describe("synthetic cross-platform journey", () => {
  it("keeps one pseudonymous subject without direct identities or content", () => {
    const subject = "a".repeat(64);
    const platforms = ["windows", "web", "ios"] as const;
    const occurredAt = new Date().toISOString();
    const expectedTime = new Date(
      Math.floor(Date.parse(occurredAt) / (5 * 60 * 1000)) * 5 * 60 * 1000,
    ).toISOString();
    const rows = platforms.map((platform) =>
      toAnalyticsRow(
        parseClientAnalyticsEvents({
          eventName: "screen.viewed",
          platform,
          occurredAt,
          properties: { screen: "library", path: `/private/${platform}` },
        })[0],
        {
          userId: USER_ID,
          subjectId: subject,
          subjectKeyVersion: 1,
          behavioralConsent: true,
          environment: "production",
        },
      ),
    );
    expect(rows.map((row) => row.platform)).toEqual(platforms);
    expect(rows.every((row) => row.subject_id === subject)).toBe(true);
    expect(rows.every((row) => row.user_id === null && row.anonymous_id === null)).toBe(true);
    expect(rows.every((row) => !("path" in row.properties))).toBe(true);
    expect(rows.every((row) => row.occurred_at === expectedTime)).toBe(true);
  });
});
