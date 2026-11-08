import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { createPendingGame, searchGames } from "./gameRecords";
import worker from "./index";
import { allowAllLimiters, clearRateLimitBuckets } from "./rateLimit";

const USER = "11111111-1111-4111-8111-111111111111";

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
    ...allowAllLimiters(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearRateLimitBuckets();
});

describe("game search limiter", () => {
  it("does not query games when the search limiter is missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    await expect(
      searchGames(
        new Request("https://replayr.tv/v1/games/search?q=hades"),
        env({ GAME_SEARCH_RATE_LIMITER: undefined }),
        new URL("https://replayr.tv/v1/games/search?q=hades"),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([]);
  });

  it("does not sign a playback URL when the limiter is missing", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response("[]", { status: 200 });
    });
    const response = await worker.fetch(
      new Request("https://replayr.tv/v1/clips/abcdef"),
      env({ PLAYBACK_RATE_LIMITER: undefined }),
      { waitUntil() {} },
    );
    expect(response.status).toBe(503);
    expect(hosts.some((host) => host.includes("r2"))).toBe(false);
  });
});

describe("pending game cap", () => {
  it("maps the database cap to the existing limit and does not insert a row itself", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/auth/v1/user")) {
        return json({ id: USER });
      }
      if (url.includes("/rpc/create_user_pending_game")) {
        return new Response(JSON.stringify({ message: "pending game cap", code: "P0001" }), { status: 400 });
      }
      return json([]);
    });
    const response = await createPendingGame(gameRequest(), env());
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("You already have 10 games waiting for review.");
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/rest/v1/games"))).toBe(false);
  });

  it("stores a new game through the cap function", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/auth/v1/user")) return json({ id: USER });
      if (url.includes("/rpc/create_user_pending_game")) return json("hades-ii");
      if (url.includes("/games?slug=eq.hades-ii")) {
        return json([
          {
            id: "22222222-2222-4222-8222-222222222222",
            slug: "hades-ii",
            name: "Hades II",
            publisher: null,
            cover_url: null,
            status: "pending",
          },
        ]);
      }
      return json([]);
    });
    const response = await createPendingGame(gameRequest(), env());
    expect(response.status).toBe(201);
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/rpc/create_user_pending_game"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST") && call.includes("/rest/v1/games"))).toBe(false);
  });
});

function gameRequest(): Request {
  return new Request("https://replayr.tv/v1/games", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ name: "Hades II" }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
