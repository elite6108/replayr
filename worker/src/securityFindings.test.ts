import { afterEach, describe, expect, it, vi } from "vitest";
import { accountDeleteConfirmed, assertAccountDeleteAllowed, oauthReauthIsFresh } from "./billing";
import { cors } from "./http";
import worker from "./index";
import { allowAllLimiters } from "./rateLimit";
import { inviteEmailIsConfirmed } from "./staffAuth";
import type { Env } from "./env";

describe("oauth reauth", () => {
  it("accepts a provider sign-in from the last ten minutes only", () => {
    const now = Date.now();
    expect(oauthReauthIsFresh(jwt({ amr: [{ method: "oauth", timestamp: Math.floor(now / 1000) }] }), now)).toBe(true);
    expect(oauthReauthIsFresh(jwt({ iat: Math.floor(now / 1000) }), now)).toBe(false);
    expect(oauthReauthIsFresh(jwt({ amr: [{ method: "password", timestamp: Math.floor(now / 1000) }] }), now)).toBe(false);
    expect(
      oauthReauthIsFresh(
        jwt({ iat: Math.floor(now / 1000), amr: [{ method: "oauth", timestamp: Math.floor(now / 1000) - 11 * 60 }] }),
        now,
      ),
    ).toBe(false);
    expect(
      oauthReauthIsFresh(jwt({ amr: [{ method: "google", timestamp: Math.floor(now / 1000) - 11 * 60 }] }), now),
    ).toBe(false);
  });
});

describe("account delete confirm", () => {
  it("requires the DELETE confirm body", () => {
    expect(accountDeleteConfirmed({ confirm: "DELETE" })).toBe(true);
    expect(accountDeleteConfirmed({ confirm: "delete" })).toBe(false);
    expect(accountDeleteConfirmed({})).toBe(false);
    expect(accountDeleteConfirmed(null)).toBe(false);
  });
});

describe("account delete password", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_ANON_KEY: "anon",
  } as Env;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a wrong password before any billing call", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      hosts.push(url.hostname);
      if (url.pathname.includes("/admin/users/")) {
        return new Response(JSON.stringify({ email: "player@replayr.tv", identities: [{ provider: "email" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "invalid" }), { status: 400 });
    });
    await expect(assertAccountDeleteAllowed(env, "user-1", "token", { password: "wrong-password" })).rejects.toMatchObject({
      status: 401,
    });
    expect(hosts).not.toContain("api.stripe.com");
  });

  it("rejects a missing identity list before any billing call", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response(JSON.stringify({ email: "player@replayr.tv" }), { status: 200 });
    });
    await expect(assertAccountDeleteAllowed(env, "user-1", freshOAuthToken(), {})).rejects.toMatchObject({
      status: 401,
    });
    expect(hosts).not.toContain("api.stripe.com");
  });

  it("rejects an empty identity list before any billing call", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response(JSON.stringify({ email: "player@replayr.tv", identities: [] }), { status: 200 });
    });
    await expect(assertAccountDeleteAllowed(env, "user-1", freshOAuthToken(), {})).rejects.toMatchObject({
      status: 401,
    });
    expect(hosts).not.toContain("api.stripe.com");
  });

  it("accepts a fresh oauth claim for every supported provider", async () => {
    const providers = ["google", "apple", "discord", "twitter"];
    const calls: string[] = [];
    let index = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const provider = providers[index] ?? "google";
      index += 1;
      return new Response(JSON.stringify({ identities: [{ provider }] }), { status: 200 });
    });
    for (const provider of providers) {
      expect(provider).toMatch(/google|apple|discord|twitter/);
      await expect(assertAccountDeleteAllowed(env, "user-1", freshOAuthToken(), {})).resolves.toBeUndefined();
    }
    expect(calls.some((call) => call.includes("grant_type=password") || call.includes("api.stripe.com"))).toBe(false);
    expect(calls.some((call) => call.startsWith("DELETE") && call.includes("/admin/users/"))).toBe(false);
  });

  it("rejects missing, stale, or invalid provider metadata before Stripe", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response(JSON.stringify({ identities: [{ provider: "google" }] }), { status: 200 });
    });
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      jwt({ iat: now }),
      jwt({ amr: [{ method: "password", timestamp: now }] }),
      jwt({ amr: [{ method: "otp", timestamp: now }] }),
      jwt({ amr: "oauth" }),
      jwt({ iat: now, amr: [{ method: "oauth", timestamp: now - 11 * 60 }] }),
    ];
    for (const token of tokens) {
      await expect(assertAccountDeleteAllowed(env, "user-1", token, {})).rejects.toMatchObject({ status: 401 });
    }
    expect(hosts).not.toContain("api.stripe.com");
  });

  it("does not cancel a subscription when provider metadata is rejected", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/auth/v1/user") && !url.includes("/admin/")) {
        return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
      }
      if (url.includes("/admin/users/")) {
        return new Response(JSON.stringify({ identities: [{ provider: "google" }] }), { status: 200 });
      }
      if (url.includes("/billing_subscriptions")) {
        return new Response(JSON.stringify([{ stripe_subscription_id: "sub_123", status: "active" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    const now = Math.floor(Date.now() / 1000);
    const response = await worker.fetch(
      new Request("https://replayr.tv/v1/account/delete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt({ amr: [{ method: "otp", timestamp: now }] })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
      deleteEnv({ STRIPE_SECRET_KEY: "sk_test" }),
      { waitUntil() {} },
    );
    expect(response.status).toBe(401);
    expect(calls.some((call) => call.includes("api.stripe.com") || call.includes("/billing_subscriptions"))).toBe(false);
    expect(calls.some((call) => call.startsWith("DELETE") && call.includes("/admin/users/"))).toBe(false);
  });

  it("rejects an OAuth account until the provider sign-in is fresh", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      hosts.push(url.hostname);
      return new Response(JSON.stringify({ identities: [{ provider: "google" }] }), { status: 200 });
    });
    const stale = jwt({ amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) - 11 * 60 }] });
    await expect(assertAccountDeleteAllowed(env, "user-1", stale, {})).rejects.toMatchObject({
      status: 401,
      message: "Sign in with your provider again, then delete the account.",
    });
    expect(hosts).not.toContain("api.stripe.com");
    await expect(assertAccountDeleteAllowed(env, "user-1", freshOAuthToken(), {})).resolves.toBeUndefined();
    expect(hosts).not.toContain("api.stripe.com");
  });

  it("rate limits deletion before the identity check or Stripe", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      hosts.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    const response = await worker.fetch(deleteRequest(), deleteEnv({ ACCOUNT_DELETE_RATE_LIMITER: undefined }), {
      waitUntil() {},
    });
    expect(response.status).toBe(503);
    expect(hosts.some((call) => call.includes("/admin/users/") || call.includes("api.stripe.com"))).toBe(false);

    const denied = await worker.fetch(
      deleteRequest(),
      deleteEnv({ ACCOUNT_DELETE_RATE_LIMITER: { limit: async () => ({ success: false }) } }),
      { waitUntil() {} },
    );
    expect(denied.status).toBe(429);
    expect(hosts.some((call) => call.includes("/admin/users/") || call.includes("api.stripe.com"))).toBe(false);
  });

  it("cancels the subscription and keeps the Stripe customer", async () => {
    const stripe: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("api.stripe.com")) {
        stripe.push(`${method} ${new URL(url).pathname}`);
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/auth/v1/user") && !url.includes("/admin/")) {
        return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
      }
      if (url.includes("/admin/users/") && method === "DELETE") return new Response(null, { status: 200 });
      if (url.includes("/admin/users/")) {
        return new Response(JSON.stringify({ identities: [{ provider: "google" }] }), { status: 200 });
      }
      if (url.includes("/billing_subscriptions")) {
        return new Response(JSON.stringify([{ stripe_subscription_id: "sub_123", status: "active" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    const response = await worker.fetch(
      new Request("https://replayr.tv/v1/account/delete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${freshOAuthToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
      deleteEnv({ STRIPE_SECRET_KEY: "sk_test" }),
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    expect(stripe).toEqual(["DELETE /v1/subscriptions/sub_123"]);
    expect(stripe.some((call) => call.includes("/v1/customers"))).toBe(false);
  });
});

function jwt(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${body}.sig`;
}

function freshOAuthToken(): string {
  return jwt({ amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }] });
}

function deleteRequest(): Request {
  return new Request("https://replayr.tv/v1/account/delete", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
}

function deleteEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://replayr.tv",
    ...allowAllLimiters(),
    ...overrides,
  };
}

describe("production cors", () => {
  it("allows localhost origins only when the worker is local", () => {
    const production = cors(
      new Response("ok"),
      new Request("https://replayr.tv/v1/health", { headers: { origin: "http://localhost:1420" } }),
    );
    const local = cors(
      new Response("ok"),
      new Request("http://127.0.0.1:8787/v1/health", { headers: { origin: "http://localhost:1420" } }),
    );
    const app = cors(
      new Response("ok"),
      new Request("https://replayr.tv/v1/health", { headers: { origin: "https://tauri.localhost" } }),
    );
    expect(production.headers.get("access-control-allow-origin")).toBeNull();
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
    expect(app.headers.get("access-control-allow-origin")).toBe("https://tauri.localhost");
  });
});

describe("staff invite email", () => {
  it("leaves the invite pending unless the confirmed email matches", () => {
    expect(
      inviteEmailIsConfirmed(
        { email: "staff@replayr.tv", email_confirmed_at: null, confirmed_at: null },
        "staff@replayr.tv",
      ),
    ).toBe(false);
    expect(
      inviteEmailIsConfirmed(
        { email: "other@replayr.tv", email_confirmed_at: "2026-11-05T00:00:00Z" },
        "staff@replayr.tv",
      ),
    ).toBe(false);
    expect(
      inviteEmailIsConfirmed(
        { email: "staff@replayr.tv", confirmed_at: "2026-11-05T00:00:00Z" },
        "staff@replayr.tv",
      ),
    ).toBe(true);
  });
});
