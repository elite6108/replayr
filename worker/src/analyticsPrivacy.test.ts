import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import {
  analyticsSubjectForUser,
  analyticsSubjectsForErasure,
  createAnalyticsReveal,
  eraseAnalyticsForUser,
  purgeExpiredAnalyticsEvents,
  requireStaffAal2,
  roundedAnalyticsTime,
  sanitizeRevealReason,
  verifyAnalyticsReveal,
} from "./analyticsPrivacy";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
    ANALYTICS_SUBJECT_KEY: "current-test-subject-key-with-32-characters",
    ANALYTICS_SUBJECT_KEY_VERSION: "3",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("analytics privacy", () => {
  it("derives deterministic, versioned, non-reversible subjects", async () => {
    const first = await analyticsSubjectForUser(env(), USER_ID);
    const second = await analyticsSubjectForUser(env(), USER_ID);
    const other = await analyticsSubjectForUser(env(), STAFF_ID);
    expect(first).toEqual(second);
    expect(first?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.id).not.toContain(USER_ID);
    expect(first?.id).not.toBe(other?.id);
    expect(first?.keyVersion).toBe(3);
  });

  it("returns current and previous subjects for rotation-safe erasure", async () => {
    const subjects = await analyticsSubjectsForErasure(
      env({ ANALYTICS_SUBJECT_PREVIOUS_KEY: "previous-test-subject-key-with-32-characters" }),
      USER_ID,
    );
    expect(subjects.map((subject) => subject.keyVersion)).toEqual([3, 2]);
    expect(subjects[0]?.id).not.toBe(subjects[1]?.id);
  });

  it("rounds timestamps and rejects replay outside the skew window", () => {
    const now = new Date("2026-10-10T12:07:30.000Z");
    expect(roundedAnalyticsTime("2026-10-10T12:06:00.000Z", now)).toBe("2026-10-10T12:05:00.000Z");
    expect(() => roundedAnalyticsTime("2026-10-08T12:00:00.000Z", now)).toThrow(/24 hours/);
  });

  it("requires AAL2 and scopes reveal tokens to staff and target", async () => {
    expect(() => requireStaffAal2(jwtRequest("aal1"))).toThrow(/Multi-factor/);
    expect(() => requireStaffAal2(jwtRequest("aal2"))).not.toThrow();
    const subject = await analyticsSubjectForUser(env(), USER_ID);
    const created = await createAnalyticsReveal(env(), {
      staffUserId: STAFF_ID,
      targetUserId: USER_ID,
      subjectId: subject!.id,
      subjectKeyVersion: subject!.keyVersion,
      reason: "Investigate test activation",
    });
    await expect(verifyAnalyticsReveal(env(), created.token, STAFF_ID, USER_ID)).resolves.toMatchObject({
      reason: "Investigate test activation",
    });
    await expect(verifyAnalyticsReveal(env(), created.token, USER_ID, USER_ID)).rejects.toMatchObject({ status: 403 });
    await expect(verifyAnalyticsReveal(env(), `${created.token}x`, STAFF_ID, USER_ID)).rejects.toMatchObject({ status: 403 });
  });

  it("sanitizes and bounds reveal reasons", () => {
    expect(sanitizeRevealReason("  Support\ninvestigation  ")).toBe("Support investigation");
    expect(() => sanitizeRevealReason("short")).toThrow(/between 8 and 160/);
  });

  it("erases direct and rotated pseudonymous account analytics", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await eraseAnalyticsForUser(
      env({ ANALYTICS_SUBJECT_PREVIOUS_KEY: "previous-test-subject-key-with-32-characters" }),
      USER_ID,
    );
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes(`user_id=eq.${USER_ID}`))).toBe(true);
    expect(urls.filter((url) => url.includes("subject_id=eq.")).length).toBe(2);
    expect(urls.every((url) => !url.includes("email") && !url.includes("message"))).toBe(true);
  });

  it("invokes the 30-day retention purge", async () => {
    const fetchMock = vi.fn(async () => new Response("7", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(purgeExpiredAnalyticsEvents(env())).resolves.toBe(7);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { p_before: string };
    const ageDays = (Date.now() - Date.parse(body.p_before)) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
  });
});

function jwtRequest(aal: string): Request {
  const payload = btoa(JSON.stringify({ aal })).replace(/=+$/g, "");
  return new Request("https://www.replayr.tv/v1/admin/analytics/users", {
    headers: { authorization: `Bearer header.${payload}.signature` },
  });
}
