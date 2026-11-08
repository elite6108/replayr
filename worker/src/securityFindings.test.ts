import { afterEach, describe, expect, it, vi } from "vitest";
import { accountDeleteConfirmed, assertAccountDeleteAllowed } from "./billing";
import { cors } from "./http";
import { inviteEmailIsConfirmed } from "./staffAuth";
import type { Env } from "./env";

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
    await expect(assertAccountDeleteAllowed(env, "user-1", { password: "wrong-password" })).rejects.toMatchObject({
      status: 401,
    });
    expect(hosts).not.toContain("api.stripe.com");
  });
});

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
