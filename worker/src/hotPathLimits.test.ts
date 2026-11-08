import { afterEach, describe, expect, it, vi } from "vitest";
import { serveClipEmbedAsset } from "./clipEmbed";
import type { Env } from "./env";
import { handlePublicFolders } from "./folderPublic";
import worker from "./index";
import { handlePresence } from "./presence";
import { allowAllLimiters, clearRateLimitBuckets } from "./rateLimit";
import { handleScreenshotShare } from "./screenshots";

const FOLDER = "abcdefghijABCDEFGHIJ12";

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

function deny() {
  return { limit: async () => ({ success: false }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearRateLimitBuckets();
});

describe("distributed hot paths", () => {
  it("does not record presence when its limiter is missing or denying", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    const request = new Request("https://replayr.tv/v1/presence/ping", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify({ path: "/" }),
    });
    const url = new URL(request.url);
    await expect(handlePresence(request, env({ PRESENCE_ANON_RATE_LIMITER: undefined }), url)).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      handlePresence(request, env({ PRESENCE_ANON_RATE_LIMITER: deny() }), url),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toEqual([]);
  });

  it("does not look up a public folder when its limiter is missing or denying", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    const request = new Request(`https://replayr.tv/v1/public/folders/${FOLDER}`);
    const url = new URL(request.url);
    await expect(handlePublicFolders(request, env({ PUBLIC_FOLDER_RATE_LIMITER: undefined }), url)).rejects.toMatchObject({
      status: 503,
    });
    await expect(handlePublicFolders(request, env({ PUBLIC_FOLDER_RATE_LIMITER: deny() }), url)).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toEqual([]);
  });

  it("does not sign a public folder download when the download limiter is missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    const request = new Request(`https://replayr.tv/v1/public/folders/${FOLDER}/clips/clip/download`);
    await expect(
      handlePublicFolders(request, env({ PUBLIC_FOLDER_DOWNLOAD_RATE_LIMITER: undefined }), new URL(request.url)),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([]);
  });

  it("does not query the public feed when its limiter is missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    });
    const response = await worker.fetch(new Request("https://replayr.tv/v1/clips/public"), env({ PUBLIC_FEED_RATE_LIMITER: undefined }), {
      waitUntil() {},
    });
    expect(response.status).toBe(503);
    expect(calls.some((call) => call.includes("/rest/v1/clips"))).toBe(false);
    expect(calls.some((call) => call.includes("r2.cloudflarestorage.com"))).toBe(false);
  });

  it("still serves a found embed when the miss limiter is missing or denying", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const clipId = "22222222-2222-4222-8222-222222222222";
    let missChecks = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/clips?slug=eq.")) {
        return new Response(
          JSON.stringify([
            {
              id: clipId,
              user_id: userId,
              slug: "abcdef",
              title: "Clip",
              duration_ms: 1000,
              width: 1920,
              height: 1080,
              file_size_bytes: 4,
              visibility: "public",
              status: "ready",
              storage_key: `clips/${userId}/${clipId}/original.mp4`,
              thumbnail_key: `clips/${userId}/${clipId}/thumb`,
              like_count: 0,
              comment_count: 0,
              watermark: false,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("r2.cloudflarestorage.com")) {
        const range = init?.headers && new Headers(init.headers).get("range");
        if (range) {
          return new Response(new Uint8Array([1]), {
            status: 206,
            headers: { "content-range": "bytes 0-0/4", "content-length": "1" },
          });
        }
        return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200, headers: { "content-length": "4" } });
      }
      return new Response("[]", { status: 200 });
    });
    const missing = await serveClipEmbedAsset(
      new Request("https://replayr.tv/c/abcdef/video.mp4"),
      env({ PUBLIC_MISS_RATE_LIMITER: undefined }),
      "abcdef",
      "video",
    );
    expect(missing.status).toBe(200);
    expect(missing.headers.get("content-type")).toBe("video/mp4");
    const ranged = await serveClipEmbedAsset(
      new Request("https://replayr.tv/c/abcdef/video.mp4", { headers: { range: "bytes=0-0" } }),
      env({
        PUBLIC_MISS_RATE_LIMITER: {
          limit: async () => {
            missChecks += 1;
            return { success: false };
          },
        },
      }),
      "abcdef",
      "video",
    );
    expect(ranged.status).toBe(206);
    expect(missChecks).toBe(0);
  });

  it("does not sign a missing embed when the miss limiter is missing", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response("[]", { status: 200 });
    });
    await expect(
      serveClipEmbedAsset(
        new Request("https://replayr.tv/c/abcdef/video.mp4"),
        env({ PUBLIC_MISS_RATE_LIMITER: undefined }),
        "abcdef",
        "video",
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(hosts.some((host) => host.includes("r2"))).toBe(false);
  });

  it("does not sign a missing screenshot when the miss limiter is missing", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname);
      return new Response("[]", { status: 200 });
    });
    await expect(
      handleScreenshotShare(
        new Request("https://replayr.tv/s/abcdefghijk2.png"),
        env({ PUBLIC_MISS_RATE_LIMITER: undefined }),
        new URL("https://replayr.tv/s/abcdefghijk2.png"),
        {
          streams: { wrapFixedLength: (_length, body) => body },
          fetchSpaShell: async () => "<html></html>",
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(hosts.some((host) => host.includes("r2"))).toBe(false);
  });
});
