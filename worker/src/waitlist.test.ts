import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { handleWaitlist } from "./site-access";
import {
  buildWaitlistAiUserPrompt,
  drainWaitlistCampaigns,
  formatWaitlistUpdates,
  loadCampaignRecipients,
  newestReleases,
  parseRewriteJson,
  rewriteWaitlistCopy,
  waitlistRowIsSubscribed,
} from "./waitlistAdmin";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://replayr.tv",
    RESEND_API_KEY: "re_test",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("waitlist helpers", () => {
  it("skips unsubscribed rows", () => {
    expect(waitlistRowIsSubscribed({ unsubscribed_at: null })).toBe(true);
    expect(waitlistRowIsSubscribed({ unsubscribed_at: "2026-09-17T00:00:00.000Z" })).toBe(false);
  });

  it("parses AI rewrite JSON", () => {
    expect(parseRewriteJson(`{"subject":"Soon","body":"Replayr is close."}`)).toEqual({
      subject: "Soon",
      body: "Replayr is close.",
    });
    expect(parseRewriteJson("not json")).toBeNull();
  });

  it("asks the model to write a new email when there is no draft", () => {
    expect(
      buildWaitlistAiUserPrompt({
        subject: "",
        body: "",
        goal: "Hype screenshots",
        talkingPoints: "",
        updates: "v0.1.51\n- Cloud screenshots",
      }),
    ).toContain("Operator brief");
    expect(
      formatWaitlistUpdates({
        announcements: [{ title: "Beta", body: "Soon" }],
        releases: [{ version: "0.1.51", items: ["Cloud screenshots"] }],
      }),
    ).toContain("v0.1.51");
    expect(newestReleases({ "0.1.50": ["Old"], "0.1.51": ["New"] }, 1)).toEqual([
      { version: "0.1.51", items: ["New"] },
    ]);
  });
});

describe("waitlist signup confirmation", () => {
  it("sends confirmation mail on first insert and not on duplicates", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("/rest/v1/waitlist_emails") && init?.method === "POST") {
          const created = JSON.parse(String(init.body)) as { email: string };
          if (created.email === "repeat@example.com") {
            return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
          }
          return new Response(
            JSON.stringify([
              {
                id: "11111111-1111-4111-8111-111111111111",
                email: created.email,
                unsubscribe_token: "22222222-2222-4222-8222-222222222222",
              },
            ]),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("api.resend.com")) {
          return new Response(JSON.stringify({ id: "email_1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/rest/v1/waitlist_emails") && init?.method === "PATCH") {
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const first = await handleWaitlist(
      new Request("https://replayr.tv/v1/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com" }),
      }),
      env(),
    );
    expect(first?.status).toBe(200);
    const firstBody = (await first!.json()) as { ok: boolean; delivery?: { sent: boolean } };
    expect(firstBody.delivery?.sent).toBe(true);
    expect(calls.some((call) => call.includes("api.resend.com"))).toBe(true);

    const resendCalls = calls.filter((call) => call.includes("api.resend.com")).length;
    const duplicate = await handleWaitlist(
      new Request("https://replayr.tv/v1/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: "repeat@example.com" }),
      }),
      env(),
    );
    expect(duplicate?.status).toBe(200);
    expect(calls.filter((call) => call.includes("api.resend.com")).length).toBe(resendCalls);
  });

  it("marks a valid unsubscribe token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("unsubscribe_token=eq.") && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify([{ id: "11111111-1111-4111-8111-111111111111", unsubscribed_at: null }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const response = await handleWaitlist(
      new Request("https://replayr.tv/v1/waitlist/unsubscribe?token=11111111-1111-4111-8111-111111111111"),
      env(),
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("You're off the Replayr waitlist");
  });
});

describe("waitlist campaigns", () => {
  it("loads selected subscribed ids and skips unsubscribed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@example.com", unsubscribed_at: null },
            { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "b@example.com", unsubscribed_at: "2026-01-01T00:00:00Z" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const rows = await loadCampaignRecipients(env(), "selected", [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(rows).toEqual([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@example.com" }]);
  });

  it("does not send campaign mail to unsubscribed recipients", async () => {
    const send = vi.fn(async () => ({ sent: true, providerId: "email_x" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("waitlist_campaign_recipients") && url.includes("waitlist_emails(")) {
          return new Response(
            JSON.stringify([
              {
                id: "r1",
                campaign_id: "c1",
                waitlist_id: "w1",
                waitlist_emails: {
                  email: "gone@example.com",
                  unsubscribe_token: "33333333-3333-4333-8333-333333333333",
                  unsubscribed_at: "2026-09-01T00:00:00Z",
                },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/waitlist_campaigns?id=in.")) {
          return new Response(
            JSON.stringify([
              {
                id: "c1",
                subject: "Hype",
                body: "Soon",
                status: "queued",
                recipient_count: 1,
                sent_count: 0,
                failed_count: 0,
                skipped_count: 0,
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("prefer") || init?.headers && String((init.headers as Record<string, string>).prefer || "").includes("count")) {
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json", "content-range": "0-0/0" },
          });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const result = await drainWaitlistCampaigns(env(), send as never);
    expect(result.processed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("waitlist AI copy", () => {
  it("requires an OpenAI key", async () => {
    await expect(
      rewriteWaitlistCopy(env(), { subject: "", body: "", talkingPoints: "Soon", includeUpdates: false }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("calls OpenAI and returns subject and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.openai.com")) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ subject: "It's close", body: "Replayr at replayr.tv and @Replayr_TV." }) } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const draft = await rewriteWaitlistCopy(env({ OPENAI_API_KEY: "sk-test" }), {
      subject: "",
      body: "",
      talkingPoints: "Closed beta next month",
      includeUpdates: false,
    });
    expect(draft.subject).toBe("It's close");
    expect(draft.body).toContain("replayr.tv");
  });
});
