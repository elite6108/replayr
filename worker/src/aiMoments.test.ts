import { afterEach, describe, expect, it, vi } from "vitest";
import { applyShortPicks, applyWindowPicks, handleAiMoments, mp4DurationMs, mp4HeaderFacts, parseRankJson, planShorts, sanitizeMoments, speechWindows, TRANSCRIPTION_LIMIT_SECONDS } from "./aiMoments";
import { freeUploadHeaderError } from "./billing";
import type { Env } from "./env";
import { HttpError } from "./http";
import { clearRateLimitBuckets } from "./rateLimit";

const USER = "11111111-1111-4111-8111-111111111111";

describe("transcription allowance", () => {
  it("caps each user at 50 minutes", () => {
    expect(TRANSCRIPTION_LIMIT_SECONDS).toBe(50 * 60);
  });
});

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
    OPENAI_API_KEY: "sk-test",
  };
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  out.set([...type].map((char) => char.charCodeAt(0)), 4);
  out.set(body, 8);
  return out;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Two-second mp4 whose mvhd the worker can time without a decoder. */
function sampleAudio(): Uint8Array {
  const mvhd = new Uint8Array(20);
  mvhd.set(u32(1000), 12);
  mvhd.set(u32(2000), 16);
  return concat([box("ftyp", new Uint8Array(8)), box("moov", box("mvhd", mvhd))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function premium(slug: "pro" | "free") {
  return [
    {
      storage_used_bytes: 0,
      storage_limit_bytes: 100,
      plans: {
        slug,
        storage_limit_bytes: 100,
        max_clip_duration_ms: null,
        max_upload_quality: "original",
        watermark: false,
        ads: false,
        screenshot_count_limit: null,
        screenshot_bytes_limit: null,
      },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRateLimitBuckets();
});

describe("moment bounds", () => {
  it("reads a version-0 movie header", () => {
    expect(mp4DurationMs(sampleAudio())).toBe(2000);
    expect(mp4DurationMs(new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]))).toBeNull();
    const mvhd = new Uint8Array(20);
    mvhd.set(u32(1000), 12);
    mvhd.set(u32(2000), 16);
    const tkhd = new Uint8Array(84);
    tkhd.set(u32(1920 * 65536), 76);
    tkhd.set(u32(1080 * 65536), 80);
    const video = concat([
      box("ftyp", new Uint8Array(8)),
      box("moov", concat([box("mvhd", mvhd), box("trak", box("tkhd", tkhd))])),
    ]);
    expect(mp4HeaderFacts(video)).toEqual({ durationMs: 2000, width: 1920, height: 1080 });
    expect(mp4HeaderFacts(new Uint8Array(8))).toEqual({ durationMs: null, width: null, height: null });
  });

  it("rejects a free upload that is over 1080p or unreadable", () => {
    const free = { maxClipDurationMs: 1_200_000, maxUploadQuality: "1080p" };
    expect(freeUploadHeaderError(free, { durationMs: 2_000, width: 1920, height: 1080 })).toBeNull();
    expect(freeUploadHeaderError(free, { durationMs: 2_000, width: 1080, height: 1920 })).toBeNull();
    expect(freeUploadHeaderError(free, { durationMs: 2_000, width: 2560, height: 1440 })).toMatch(/1080p/);
    expect(freeUploadHeaderError(free, { durationMs: null, width: 1920, height: 1080 })).toMatch(/could not be checked/);
    expect(freeUploadHeaderError({ maxClipDurationMs: null, maxUploadQuality: "original" }, { durationMs: null, width: null, height: null })).toBeNull();
  });

  it("drops moments that are too short, too long, or overlapping", () => {
    const moments = sanitizeMoments(
      [
        { startMs: 0, endMs: 10_000, title: "Too short", reason: "no" },
        { startMs: 0, endMs: 30_000, title: "Keep", reason: "callout" },
        { startMs: 20_000, endMs: 50_000, title: "Overlap", reason: "later" },
        { startMs: 70_000, endMs: 400_000, title: "Too long", reason: "no" },
        { startMs: 90_000, endMs: 120_000, title: "Second", reason: "clutch" },
      ],
      180_000,
      "youtube",
    );
    expect(moments.map((moment) => moment.title)).toEqual(["Keep", "Second"]);
  });

  it("builds saveable scenes from short spoken lines", () => {
    const lines = Array.from({ length: 90 }, (_, index) => ({
      startMs: index * 2_000,
      endMs: index * 2_000 + 1_500,
      text: `line ${index}`,
    }));
    const windows = speechWindows(lines, 180_000, "reel");
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.endMs - window.startMs >= 15_000 && window.endMs - window.startMs <= 60_000)).toBe(true);
    expect(windows[1].startMs).toBeGreaterThanOrEqual(windows[0].endMs);
    expect(applyWindowPicks(windows, [{ index: 1, title: "Clutch", reason: "callout" }]).map((moment) => moment.title)).toEqual(["Clutch"]);
  });

  it("picks five hook-to-payoff shorts from a four minute transcript", () => {
    const lines = Array.from({ length: 120 }, (_, index) => ({
      startMs: index * 2_000,
      endMs: index * 2_000 + 1_600,
      text: "we just clutched that fight and I cannot believe the shot",
    }));
    const { pool, chosen } = planShorts(lines, 240_000);
    const edges = new Set(lines.flatMap((line) => [line.startMs, line.endMs]));
    expect(chosen).toHaveLength(5);
    expect(chosen.every((window) => window.endMs - window.startMs >= 20_000 && window.endMs - window.startMs <= 40_000)).toBe(true);
    expect(chosen.every((window) => edges.has(window.startMs) && edges.has(window.endMs))).toBe(true);
    expect(chosen.slice(1).every((window, index) => window.startMs >= chosen[index].endMs)).toBe(true);
    const titled = applyShortPicks(pool, [{ index: 1, title: "Clutch", reason: "callout" }], chosen, chosen.length);
    const clutch = titled.find((moment) => moment.title === "Clutch");
    expect(clutch?.startMs).toBe(pool[1].startMs);
    expect(clutch?.endMs).toBe(pool[1].endMs);
  });

  it("prefers a later callout over an opening that is only filler", () => {
    const filler = Array.from({ length: 20 }, (_, index) => ({
      startMs: index * 2_000,
      endMs: index * 2_000 + 800,
      text: index % 2 === 0 ? "um" : "yeah",
    }));
    const walking = Array.from({ length: 40 }, (_, index) => ({
      startMs: 40_000 + index * 2_000,
      endMs: 40_000 + index * 2_000 + 1_200,
      text: "we are walking around the map right now",
    }));
    const callout = Array.from({ length: 40 }, (_, index) => ({
      startMs: 120_000 + index * 2_000,
      endMs: 120_000 + index * 2_000 + 1_900,
      text: "No way he just missed that shot completely!",
    }));
    const { pool, chosen } = planShorts([...filler, ...walking, ...callout], 240_000);
    expect(chosen.every((window) => window.startMs >= 40_000)).toBe(true);
    expect(chosen.some((window) => window.startMs === 120_000)).toBe(true);
    const hook = pool.find((window) => window.startMs === 120_000);
    const setup = pool.find((window) => window.startMs === 40_000);
    expect(hook && setup && hook.score > setup.score).toBe(true);
  });

  it("offers one short when the clip is under 90 seconds", () => {
    const lines = Array.from({ length: 35 }, (_, index) => ({
      startMs: index * 2_000,
      endMs: index * 2_000 + 1_600,
      text: "that fight was absolutely wild from the start",
    }));
    const { chosen } = planShorts(lines, 80_000);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].endMs - chosen[0].startMs).toBeGreaterThanOrEqual(20_000);
    expect(chosen[0].endMs - chosen[0].startMs).toBeLessThanOrEqual(40_000);
  });

  it("parses a JSON object wrapped in extra text", () => {
    expect(parseRankJson('sure {"moments":[{"startMs":1}]}')).toEqual([{ startMs: 1 }]);
    expect(parseRankJson("no json")).toBeNull();
  });
});

describe("ai moment routes", () => {
  it("rejects a free account before any audio is sent to the model", async () => {
    const calls: string[] = [];
    stubWorker(calls, { plan: "free" });
    const caught = await postAudio("free-token").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(403);
    expect(calls.some((call) => call.includes("api.openai.com"))).toBe(false);
    expect(calls.some((call) => call.includes("reserve_ai_seconds"))).toBe(false);
  });

  it("returns a stored transcript without reserving more minutes", async () => {
    const calls: string[] = [];
    stubWorker(calls, {
      plan: "pro",
      transcript: {
        id: "22222222-2222-4222-8222-222222222222",
        duration_ms: 2000,
        segments: [{ startMs: 0, endMs: 2000, text: "Clutch" }],
      },
    });
    const response = await postAudio("cache-token");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cached: boolean; transcriptId: string };
    expect(body.cached).toBe(true);
    expect(body.transcriptId).toBe("22222222-2222-4222-8222-222222222222");
    expect(calls.some((call) => call.includes("reserve_ai_seconds"))).toBe(false);
    expect(calls.some((call) => call.includes("api.openai.com"))).toBe(false);
  });

  it("refunds the reservation when transcription fails", async () => {
    const calls: string[] = [];
    stubWorker(calls, { plan: "pro", whisperStatus: 500 });
    const caught = await postAudio("fail-token").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(502);
    expect(calls.filter((call) => call.includes("/rpc/reserve_ai_seconds"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("/rpc/refund_ai_seconds"))).toHaveLength(1);
  });

  it("turns a full month into a 403", async () => {
    const calls: string[] = [];
    stubWorker(calls, { plan: "pro", quotaFull: true });
    const caught = await postAudio("full-token").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(403);
    expect((caught as HttpError).message).toMatch(/limit reached/i);
    expect(calls.some((call) => call.includes("api.openai.com"))).toBe(false);
  });
});

function postAudio(token: string): Promise<Response> {
  const form = new FormData();
  form.set("part", new File([sampleAudio()], "speech.m4a", { type: "audio/mp4" }));
  return handleAiMoments(
    new Request("https://replayr.tv/v1/ai/moments/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
    env(),
    new URL("https://replayr.tv/v1/ai/moments/transcribe"),
  ) as Promise<Response>;
}

function stubWorker(
  calls: string[],
  options: {
    plan: "pro" | "free";
    transcript?: { id: string; duration_ms: number; segments: { startMs: number; endMs: number; text: string }[] };
    whisperStatus?: number;
    quotaFull?: boolean;
  },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) {
        return json({ id: USER, email: "player@example.com" });
      }
      if (url.includes("/user_storage?")) return json(premium(options.plan));
      if (url.includes("/billing_subscriptions?")) return json([]);
      if (url.includes("/billing_grants?")) return json([]);
      if (url.includes("/app_settings?")) return json([{ watermark_enabled: true, ads_enabled: true }]);
      if (url.includes("/ai_transcripts?") && (init?.method || "GET") === "GET") {
        return json(options.transcript ? [options.transcript] : []);
      }
      if (url.includes("/rpc/reserve_ai_seconds")) {
        if (options.quotaFull) {
          return new Response(JSON.stringify({ message: "Monthly transcription limit reached." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return json(120);
      }
      if (url.includes("/rpc/refund_ai_seconds") || url.includes("/rpc/note_ai_seconds")) return json(0);
      if (url.includes("api.openai.com/v1/audio/transcriptions")) {
        return new Response("no", { status: options.whisperStatus ?? 200 });
      }
      return json([]);
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
