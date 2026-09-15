import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./http";
import { clearRateLimitBuckets } from "./rateLimit";
import { isSiteGatedPath } from "./site-access";
import {
  handleScreenshotApi,
  handleScreenshotShare,
  sweepScreenshots,
  type WaitCtx,
} from "./screenshots";
import {
  injectHead,
  isScreenshotSlug,
  ownedScreenshotKey,
  parsePngHeader,
  randomScreenshotSlug,
  screenshotHeadTags,
  ScreenshotParseError,
} from "./screenshotsCore";
import type { Env } from "./env";

const USER = "11111111-1111-4111-8111-111111111111";
const SHOT = "22222222-2222-4222-8222-222222222222";
const KEY = `screenshots/${USER}/${SHOT}.png`;
const SLUG = "abcdefghijk2";

function testEnv(): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
  };
}

function pngHeader(width: number, height: number, extra = 40): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function waitCtx(): { ctx: WaitCtx; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    ctx: {
      waitUntil(task) {
        tasks.push(task);
      },
    },
  };
}

const deps = {
  streams: { wrapFixedLength: (_n: number, body: ReadableStream<Uint8Array>) => body },
  fetchSpaShell: async () =>
    `<html><head><meta name="description" content="The play already happened." /><title>Replayr</title></head><body></body></html>`,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRateLimitBuckets();
});

describe("PNG header", () => {
  it("accepts a valid IHDR", () => {
    expect(parsePngHeader(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("rejects a non-PNG signature", () => {
    const bytes = pngHeader(8, 8);
    bytes[0] = 0;
    expect(() => parsePngHeader(bytes)).toThrow(ScreenshotParseError);
    try {
      parsePngHeader(bytes);
    } catch (caught) {
      expect((caught as ScreenshotParseError).code).toBe("screenshot_not_png");
    }
  });

  it("rejects oversized dimensions", () => {
    try {
      parsePngHeader(pngHeader(20000, 8));
      throw new Error("expected throw");
    } catch (caught) {
      expect((caught as ScreenshotParseError).code).toBe("screenshot_too_large");
    }
  });

  it("rejects more than 50 megapixels", () => {
    try {
      parsePngHeader(pngHeader(10000, 10000));
      throw new Error("expected throw");
    } catch (caught) {
      expect((caught as ScreenshotParseError).code).toBe("screenshot_too_large");
    }
  });
});

describe("slug charset", () => {
  it("uses rejection sampling and the advertised alphabet", () => {
    const slug = randomScreenshotSlug(() => new Uint8Array([0, 31, 32, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(isScreenshotSlug(slug)).toBe(true);
    expect(slug).not.toMatch(/[01l]/);
  });

  it("rejects injection before any PostgREST query", () => {
    expect(isScreenshotSlug("abcdefghijk2")).toBe(true);
    expect(isScreenshotSlug("abc_inj)or")).toBe(false);
    expect(isScreenshotSlug("abcdefghijk2.png")).toBe(false);
    expect(isScreenshotSlug("ABCDEFGHIJK2")).toBe(false);
  });
});

describe("screenshot object keys", () => {
  it("accepts screenshots/{user}/{id}.png and never a clip key", () => {
    expect(ownedScreenshotKey(USER, KEY)).toBe(true);
    expect(ownedScreenshotKey(USER, `clips/${USER}/${SHOT}/original.mp4`)).toBe(false);
    expect(ownedScreenshotKey(USER, `screenshots/${USER}/../${SHOT}.png`)).toBe(false);
    expect(ownedScreenshotKey("not-a-uuid", KEY)).toBe(false);
  });
});

describe("injectHead", () => {
  const shell = `<html><head><meta name="description" content="The play already happened. Replayr keeps Instant Replay rolling." /><title>Replayr</title></head><body></body></html>`;

  it("strips the marketing description and injects og tags", () => {
    const html = injectHead(shell, screenshotHeadTags({ origin: "https://replayr.tv", slug: SLUG, found: true, width: 8, height: 8 }));
    expect(html).not.toMatch(/The play already happened/);
    expect(html).not.toContain("<title>Replayr</title>");
    expect(html).toContain("<title>Screenshot · Replayr</title>");
    expect(html).toContain('property="og:image"');
    expect(html).toContain(`https://replayr.tv/s/${SLUG}.png`);
    expect(html).toContain("summary_large_image");
  });

  it("404 has no og:image", () => {
    const html = injectHead(shell, screenshotHeadTags({ origin: "https://replayr.tv", slug: SLUG, found: false }));
    expect(html).not.toContain("og:image");
    expect(html).toContain("noindex");
  });
});

describe("POST /v1/screenshots", () => {
  it("returns 401 with code unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(
      handleScreenshotApi(
        new Request("https://www.replayr.tv/v1/screenshots", { method: "POST", headers: { "content-length": "80" } }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/screenshots"),
        waitCtx().ctx,
        deps,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("returns 413 when Content-Length is over 32 MiB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: USER }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    await expect(
      handleScreenshotApi(
        new Request("https://www.replayr.tv/v1/screenshots", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-length": String(33 * 1024 * 1024) },
          body: new Uint8Array([1]),
        }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/screenshots"),
        waitCtx().ctx,
        deps,
      ),
    ).rejects.toMatchObject({ status: 413, code: "screenshot_too_large" });
  });

  it("returns 415 when the body is not a PNG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: USER }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const junk = new Uint8Array(80).fill(7);
    await expect(
      handleScreenshotApi(
        new Request("https://www.replayr.tv/v1/screenshots", {
          method: "POST",
          headers: { authorization: "Bearer t", "content-length": String(junk.byteLength) },
          body: junk,
        }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/screenshots"),
        waitCtx().ctx,
        deps,
      ),
    ).rejects.toMatchObject({ status: 415, code: "screenshot_not_png" });
  });

  it("finalizes then waitUntil-deletes the evicted R2 object", async () => {
    const png = pngHeader(8, 8, 40);
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: USER }), { status: 200 });
        }
        if (url.includes("/rpc/reserve_screenshot")) {
          return new Response(JSON.stringify(KEY), { status: 200 });
        }
        if (url.includes("r2.cloudflarestorage.com") && method === "PUT") {
          return new Response(null, { status: 200 });
        }
        if (url.includes("/rpc/finalize_screenshot")) {
          return new Response(
            JSON.stringify({
              slug: SLUG,
              width: 8,
              height: 8,
              evicted: [{ id: "33333333-3333-4333-8333-333333333333", key: `screenshots/${USER}/33333333-3333-4333-8333-333333333333.png` }],
              usage: { count: 10, bytes: 80 },
              limits: { count: 10, bytes: null },
              trimAfter: null,
            }),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const { ctx, tasks } = waitCtx();
    const response = await handleScreenshotApi(
      new Request("https://www.replayr.tv/v1/screenshots", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-length": String(png.byteLength) },
        body: png,
      }),
      testEnv(),
      new URL("https://www.replayr.tv/v1/screenshots"),
      ctx,
      {
        ...deps,
        deleteObject: async (_env, key) => {
          deleted.push(key);
        },
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { replacedOldest: boolean; slug: string; evictedIds: string[] };
    expect(body.replacedOldest).toBe(true);
    expect(body.slug).toBe(SLUG);
    expect(body.evictedIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    await Promise.all(tasks);
    expect(deleted).toEqual([`screenshots/${USER}/33333333-3333-4333-8333-333333333333.png`]);
  });
});

describe("GET /v1/screenshots/public/:slug", () => {
  it("only returns ready rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("status=eq.ready") && url.includes(`slug=eq.${SLUG}`)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    await expect(
      handleScreenshotApi(
        new Request(`https://www.replayr.tv/v1/screenshots/public/${SLUG}`),
        testEnv(),
        new URL(`https://www.replayr.tv/v1/screenshots/public/${SLUG}`),
        waitCtx().ctx,
        deps,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("sweep", () => {
  it("deletes the R2 object before compare-and-set", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("status=eq.uploading")) return new Response("[]", { status: 200 });
        if (url.includes("status=in.(failed,deleted)")) {
          return new Response(
            JSON.stringify([{ id: SHOT, user_id: USER, storage_key: KEY }]),
            { status: 200 },
          );
        }
        if (url.includes("/rpc/mark_screenshot_purged")) {
          order.push("cas");
          return new Response("true", { status: 200 });
        }
        if (url.includes("/rpc/")) return new Response("[]", { status: 200 });
        return new Response("[]", { status: 200 });
      }),
    );
    await sweepScreenshots(testEnv(), waitCtx().ctx, {
      ...deps,
      deleteObject: async () => {
        order.push("delete");
      },
    });
    expect(order).toEqual(["delete", "cas"]);
  });
});

describe("site gate", () => {
  it("keeps /s/ open", () => {
    expect(isSiteGatedPath(`/s/${SLUG}`)).toBe(false);
    expect(isSiteGatedPath(`/s/${SLUG}.png`)).toBe(false);
    expect(isSiteGatedPath("/")).toBe(true);
  });
});

describe("share page", () => {
  it("serves a 404 shell without og:image when the slug misses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const response = await handleScreenshotShare(
      new Request(`https://www.replayr.tv/s/${SLUG}`),
      testEnv(),
      new URL(`https://www.replayr.tv/s/${SLUG}`),
      deps,
    );
    expect(response?.status).toBe(404);
    const html = await response!.text();
    expect(html).not.toContain("og:image");
    expect(html).not.toMatch(/The play already happened/);
    expect(html).toContain("This screenshot is no longer available.");
  });

  it("HEAD of a png fetches R2 with GET so crawlers do not 404", async () => {
    const row = [
      {
        id: SHOT,
        user_id: USER,
        slug: SLUG,
        storage_key: KEY,
        width: 8,
        height: 8,
        file_size_bytes: 80,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/rest/v1/screenshots")) {
          return new Response(JSON.stringify(row), { status: 200 });
        }
        if (url.includes("r2.cloudflarestorage.com")) {
          expect(init?.method ?? "GET").toBe("GET");
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-length": "3", etag: '"abc"' },
          });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const response = await handleScreenshotShare(
      new Request(`https://replayr.tv/s/${SLUG}.png`, { method: "HEAD" }),
      testEnv(),
      new URL(`https://replayr.tv/s/${SLUG}.png`),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(await response!.arrayBuffer()).toHaveProperty("byteLength", 0);
  });
});
