import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { listDetectionCatalog, searchGames } from "./gameRecords";
import { handlePublicFolders } from "./folderPublic";
import worker from "./index";
import { handlePresence } from "./presence";
import { allowAllLimiters, clearRateLimitBuckets } from "./rateLimit";

const USER = "11111111-1111-4111-8111-111111111111";
const CLIP = "22222222-2222-4222-8222-222222222222";

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "content-range": "*/0" },
  });
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearRateLimitBuckets();
});

describe("local measurements", () => {
  it("pages the detection catalog four times and does not need a faster loop", async () => {
    const page = Array.from({ length: 500 }, (_, index) => ({
      id: CLIP,
      slug: `game-${index}`,
      name: `Game ${index}`,
      publisher: null,
      cover_url: null,
      icon_url: null,
      process_names: ["game.exe"],
    }));
    let catalogQueries = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return json({ id: USER });
      if (url.includes("process_names")) {
        catalogQueries += 1;
        return json(page);
      }
      return json([]);
    });
    const started = performance.now();
    const response = await listDetectionCatalog(
      new Request("https://replayr.tv/v1/games/catalog", { headers: { authorization: "Bearer catalog-token" } }),
      env(),
    );
    const elapsedMs = performance.now() - started;
    expect(response.status).toBe(200);
    expect(catalogQueries).toBe(4);
    console.log(JSON.stringify({ measurement: "catalog", catalogQueries, elapsedMs: Math.round(elapsedMs), note: "Mocked local timing, not hosted capacity." }));
  });

  it("measures playback, search, presence, and upload continuation without a hosted target", async () => {
    const clip = {
      id: CLIP,
      user_id: USER,
      slug: "abcdef",
      title: "Clip",
      duration_ms: 1000,
      width: 1920,
      height: 1080,
      file_size_bytes: 1000,
      visibility: "public",
      status: "ready",
      storage_key: `clips/${USER}/${CLIP}/original.mp4`,
      thumbnail_key: `clips/${USER}/${CLIP}/thumb`,
      like_count: 0,
      comment_count: 0,
      watermark: false,
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) return json({ id: USER });
      if (url.includes("/upload_sessions")) {
        return json([
          {
            storage_key: `clips/${USER}/${CLIP}/original.mp4`,
            multipart_upload_id: "upload-1",
            expected_size_bytes: 5_000_000,
            status: "uploading",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ]);
      }
      if (url.includes("/clips?id=eq.")) {
        return json([{ ...clip, status: "uploading", thumbnail_key: null }]);
      }
      if (url.includes("/clips?slug=eq.")) return json([clip]);
      if (url.includes("name.ilike")) return json([]);
      return json([]);
    });
    const ctx = { waitUntil() {} };
    const base = env();

    async function time(run: () => Promise<number>): Promise<{ ms: number; status: number }> {
      const started = performance.now();
      const status = await run();
      return { ms: performance.now() - started, status };
    }

    const playback = await Promise.all(
      Array.from({ length: 8 }, () =>
        time(async () =>
          (
            await worker.fetch(new Request("https://replayr.tv/v1/clips/abcdef"), base, ctx)
          ).status,
        ),
      ),
    );
    const search = await Promise.all(
      Array.from({ length: 8 }, () =>
        time(async () =>
          (
            await searchGames(
              new Request("https://replayr.tv/v1/games/search?q=replay"),
              base,
              new URL("https://replayr.tv/v1/games/search?q=replay"),
            )
          ).status,
        ),
      ),
    );
    const presence = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        time(async () => {
          const response = await handlePresence(
            new Request("https://replayr.tv/v1/presence/ping", {
              method: "POST",
              headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${index}` },
              body: JSON.stringify({ path: "/" }),
            }),
            base,
            new URL("https://replayr.tv/v1/presence/ping"),
          );
          return response?.status ?? 0;
        }),
      ),
    );
    const uploads = await Promise.all(
      Array.from({ length: 8 }, () =>
        time(async () =>
          (
            await worker.fetch(
              new Request(`https://replayr.tv/v1/clips/${CLIP}/upload-parts`, {
                method: "POST",
                headers: { authorization: "Bearer upload-token", "content-type": "application/json" },
                body: JSON.stringify({ partNumbers: [1] }),
              }),
              base,
              ctx,
            )
          ).status,
        ),
      ),
    );

    const report = {
      measurement: "local-handlers",
      note: "Mocked local timing, not hosted capacity.",
      playback: summarize(playback, 200),
      search: summarize(search, 200),
      presence: summarize(presence, 202),
      uploads: summarize(uploads, 200),
    };
    console.log(JSON.stringify(report));
    expect(report.playback.errors).toBe(0);
    expect(report.search.errors).toBe(0);
    expect(report.presence.errors).toBe(0);
    expect(report.uploads.errors).toBe(0);
  });

  it("measures public folder page, playback, and download without a hosted target", async () => {
    const folderId = "33333333-3333-4333-8333-333333333333";
    const token = "abcdefghijABCDEFGHIJ12";
    const folder = {
      id: folderId,
      owner_id: USER,
      name: "Public",
      description: null,
      visibility: "public_link",
      allow_downloads: true,
      allow_public_downloads: true,
      public_enabled: true,
      public_slug: null,
      public_token_hash: "hash",
      public_token_version: 1,
      public_enabled_at: new Date().toISOString(),
      cover_clip_id: CLIP,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const clip = {
      id: CLIP,
      user_id: USER,
      title: "Clip",
      status: "ready",
      visibility: "public",
      duration_ms: 1000,
      created_at: new Date().toISOString(),
      storage_key: `clips/${USER}/${CLIP}/original.mp4`,
      thumbnail_key: `clips/${USER}/${CLIP}/thumb`,
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/folders?")) return json([folder]);
      if (url.includes("/folder_clips")) {
        return json([{ folder_id: folderId, clip_id: CLIP, added_by: USER, position: 0, created_at: clip.created_at }]);
      }
      if (url.includes("/clips?")) return json([clip]);
      if (url.includes("/profiles?")) {
        return json([{ id: USER, username: "player", display_name: "Player", avatar_url: null, is_verified: false }]);
      }
      return json([]);
    });
    const base = env();

    async function time(path: string): Promise<{ ms: number; status: number }> {
      const started = performance.now();
      const response = await handlePublicFolders(new Request(`https://replayr.tv${path}`), base, new URL(`https://replayr.tv${path}`));
      return { ms: performance.now() - started, status: response?.status ?? 0 };
    }

    const page = await Promise.all(Array.from({ length: 8 }, () => time(`/v1/public/folders/${token}`)));
    const playback = await Promise.all(
      Array.from({ length: 8 }, () => time(`/v1/public/folders/${token}/clips/${CLIP}/playback`)),
    );
    const download = await Promise.all(
      Array.from({ length: 8 }, () => time(`/v1/public/folders/${token}/clips/${CLIP}/download`)),
    );
    const report = {
      measurement: "public-folders",
      note: "Mocked local timing, not hosted capacity.",
      page: summarize(page, 200),
      playback: summarize(playback, 200),
      download: summarize(download, 200),
    };
    console.log(JSON.stringify(report));
    expect(report.page.errors).toBe(0);
    expect(report.playback.errors).toBe(0);
    expect(report.download.errors).toBe(0);
  });
});

function summarize(samples: Array<{ ms: number; status: number }>, expected: number) {
  const statuses = samples.map((sample) => sample.status);
  return {
    requests: samples.length,
    p95Ms: Math.round(percentile(samples.map((sample) => sample.ms), 0.95)),
    errors: statuses.filter((status) => status !== expected).length,
    statuses: Object.fromEntries(statuses.map((status) => [status, statuses.filter((item) => item === status).length])),
  };
}
