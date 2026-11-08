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
