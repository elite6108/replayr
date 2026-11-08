import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import worker from "./index";
import { allowAllLimiters, clearRateLimitBuckets } from "./rateLimit";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIP = "22222222-2222-4222-8222-222222222222";
const TOKEN = "revoked-session-token";

function env(): Env {
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
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "content-range": "*/0" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearRateLimitBuckets();
});

describe("revoked sessions", () => {
  it("keeps a cached read and rejects mutations that must be fresh", async () => {
    let authOk = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/auth/v1/user")) {
        return authOk ? json({ id: USER }) : new Response("{}", { status: 401 });
      }
      return json([]);
    });
    const headers = { authorization: `Bearer ${TOKEN}` };
    const ctx = { waitUntil() {} };

    const seeded = await worker.fetch(new Request("https://replayr.tv/v1/library", { headers }), env(), ctx);
    expect(seeded.status).toBe(200);
    authOk = false;
    const authCalls = () => calls.filter((call) => call.includes("/auth/v1/user")).length;
    const beforeRead = authCalls();
    const cached = await worker.fetch(new Request("https://replayr.tv/v1/library", { headers }), env(), ctx);
    expect(cached.status).toBe(200);
    expect(authCalls()).toBe(beforeRead);

    const upload = await worker.fetch(
      new Request(`https://replayr.tv/v1/clips/${CLIP}/upload-parts`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ partNumbers: [1] }),
      }),
      env(),
      ctx,
    );
    const like = await worker.fetch(
      new Request("https://replayr.tv/v1/clips/abcdef/like", { method: "POST", headers }),
      env(),
      ctx,
    );
    const push = await worker.fetch(
      new Request("https://replayr.tv/v1/push/tokens", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]", platform: "ios" }),
      }),
      env(),
      ctx,
    );
    const game = await worker.fetch(
      new Request(`https://replayr.tv/v1/clips/${CLIP}/game`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ gameId: CLIP }),
      }),
      env(),
      ctx,
    );
    const shot = await worker.fetch(
      new Request(`https://replayr.tv/v1/screenshots/${CLIP}`, { method: "DELETE", headers }),
      env(),
      ctx,
    );

    expect(upload.status).toBe(401);
    expect(like.status).toBe(401);
    expect(push.status).toBe(401);
    expect(game.status).toBe(401);
    expect(shot.status).toBe(401);
    expect(calls.some((call) => call.includes("r2.cloudflarestorage.com"))).toBe(false);
    expect(calls.some((call) => call.includes("/rest/v1/push_tokens"))).toBe(false);
    expect(calls.some((call) => call.includes("/rest/v1/clip_likes"))).toBe(false);
    expect(calls.some((call) => /PATCH .*\/rest\/v1\/clips/.test(call))).toBe(false);
    expect(calls.some((call) => call.includes("/rpc/delete_screenshot"))).toBe(false);
  });
});
