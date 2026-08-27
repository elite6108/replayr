import { describe, expect, it, vi, afterEach } from "vitest";
import {
  bunnyClipTitle,
  parseClipIdFromBunnyTitle,
  parseMp4Heights,
  pickDownloadResolution,
  verifyBunnyWebhookSignature,
  bunnyMp4Url,
} from "./bunny";
import type { Env } from "./env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bunny title mapping", () => {
  it("round-trips clip ids", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(bunnyClipTitle(id)).toBe(`replayr:${id}`);
    expect(parseClipIdFromBunnyTitle(bunnyClipTitle(id))).toBe(id);
    expect(parseClipIdFromBunnyTitle("other")).toBeNull();
  });
});

describe("pickDownloadResolution", () => {
  it("requires 1080 for 1080p sources and rejects silent 720 downgrade", () => {
    expect(pickDownloadResolution(1080, [720, 480])).toEqual({
      ok: false,
      error: "unavailable_mp4_resolution",
    });
    expect(pickDownloadResolution(1080, [1080, 720])).toEqual({ ok: true, resolution: 1080 });
  });

  it("picks max available at or below source height for sub-1080", () => {
    expect(pickDownloadResolution(720, [720, 480, 360])).toEqual({ ok: true, resolution: 720 });
    expect(pickDownloadResolution(900, [1080, 720])).toEqual({ ok: true, resolution: 720 });
  });
});

describe("parseMp4Heights", () => {
  it("reads heights from string or array availableResolutions", () => {
    expect(
      parseMp4Heights({
        mp4Resolutions: [{ height: 720 }],
        availableResolutions: "1080p,720p" as unknown as string[],
      }),
    ).toEqual([1080, 720]);
    expect(parseMp4Heights({}, "1080p")).toEqual([1080]);
    expect(
      parseMp4Heights({
        mp4Resolutions: [{ resolution: "720p" }],
        availableResolutions: ["360p"],
      }),
    ).toEqual([720, 360]);
  });
});

describe("verifyBunnyWebhookSignature", () => {
  it("accepts a valid HMAC-SHA256 hex signature of the raw body", async () => {
    const secret = "readonly-test-key";
    const raw = JSON.stringify({ VideoGuid: "abc", Status: 3 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const hex = [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyBunnyWebhookSignature(raw, hex, secret)).toBe(true);
    expect(await verifyBunnyWebhookSignature(raw, "deadbeef", secret)).toBe(false);
  });
});

describe("bunnyMp4Url", () => {
  it("builds a plain CDN URL when token auth is unset", async () => {
    const env = {
      BUNNY_STREAM_LIBRARY_ID: "123",
      BUNNY_STREAM_API_KEY: "key",
      BUNNY_STREAM_CDN_HOSTNAME: "vz-example.b-cdn.net",
    } as unknown as Env;
    await expect(bunnyMp4Url(env, "guid-1", 1080)).resolves.toBe(
      "https://vz-example.b-cdn.net/guid-1/play_1080p.mp4",
    );
  });

  it("appends token + expires when token auth key is set", async () => {
    const env = {
      BUNNY_STREAM_LIBRARY_ID: "123",
      BUNNY_STREAM_API_KEY: "key",
      BUNNY_STREAM_CDN_HOSTNAME: "vz-example.b-cdn.net",
      BUNNY_STREAM_TOKEN_AUTH_KEY: "tokensecret",
    } as unknown as Env;
    const url = new URL(await bunnyMp4Url(env, "guid-1", 720, 600));
    expect(url.origin + url.pathname).toBe("https://vz-example.b-cdn.net/guid-1/play_720p.mp4");
    expect(url.searchParams.get("token")).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(url.searchParams.get("expires"))).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("Bunny HTTP client (mocked)", () => {
  it("fetchBunnyVideo posts url+title with AccessKey", async () => {
    const { fetchBunnyVideo } = await import("./bunny");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, statusCode: 200, guid: "vid-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      BUNNY_STREAM_LIBRARY_ID: "99",
      BUNNY_STREAM_API_KEY: "write-key",
      BUNNY_STREAM_CDN_HOSTNAME: "cdn.example",
    } as unknown as Env;
    const result = await fetchBunnyVideo(env, {
      url: "https://www.replayr.tv/internal/bunny-source/abc",
      title: bunnyClipTitle("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    });
    expect(result.guid).toBe("vid-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://video.bunnycdn.com/library/99/videos/fetch");
    expect((call[1].headers as Record<string, string>).AccessKey).toBe("write-key");
    expect(JSON.parse(String(call[1].body))).toMatchObject({
      url: "https://www.replayr.tv/internal/bunny-source/abc",
      title: "replayr:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
  });

  it("deleteBunnyVideo ignores 404", async () => {
    const { deleteBunnyVideo } = await import("./bunny");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })),
    );
    const env = {
      BUNNY_STREAM_LIBRARY_ID: "99",
      BUNNY_STREAM_API_KEY: "write-key",
      BUNNY_STREAM_CDN_HOSTNAME: "cdn.example",
    } as unknown as Env;
    await expect(deleteBunnyVideo(env, "gone")).resolves.toBeUndefined();
  });
});
