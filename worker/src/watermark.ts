import {
  WATERMARK_PROCESSOR,
  WATERMARK_RENDER_VERSION,
  bunnyClipTitle,
  bunnyConfigured,
  deleteBunnyVideo,
  fetchBunnyMp4,
  fetchBunnyVideo,
  getBunnyResolutions,
  getBunnyVideo,
  parseClipIdFromBunnyTitle,
  parseMp4Heights,
  pickDownloadResolution,
  verifyBunnyWebhookSignature,
} from "./bunny";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import {
  objectUrl,
  ownedObjectKey,
  r2Client,
  requireR2,
  requireServiceRole,
  serviceRest,
} from "./shared";

const INGEST_TTL_MS = 60 * 60 * 1000;
const STALE_SUBMITTING_MS = 30 * 60 * 1000;
const STALE_PROCESSING_MS = 6 * 60 * 60 * 1000;

export type WatermarkVariantStatus = "none" | "submitting" | "processing" | "ready" | "failed";

interface WatermarkClipRow {
  id: string;
  user_id: string;
  slug: string;
  title: string | null;
  storage_key: string | null;
  height: number | null;
  watermark: boolean;
  watermark_variant_status: WatermarkVariantStatus;
  watermark_processor: string | null;
  watermark_processor_video_id: string | null;
  watermark_resolution: number | null;
  watermark_render_version: number | null;
  watermark_error: string | null;
  watermark_updated_at: string | null;
}

interface IngestTokenRow {
  token_hash: string;
  clip_id: string;
  expires_at: string;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

/** Bunny must pull from a public HTTPS origin — never localhost. */
function bunnyIngestOrigin(env: Env): string {
  const override = env.BUNNY_INGEST_PUBLIC_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/, "");
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured && /^https:\/\//i.test(configured) && !/127\.0\.0\.1|localhost/i.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  return "https://www.replayr.tv";
}

async function claimWatermarkJob(env: Env, clipId: string): Promise<boolean> {
  requireServiceRole(env);
  const result = await serviceRest<boolean | Array<{ claim_watermark_variant?: boolean }>>(
    env,
    "POST",
    "/rpc/claim_watermark_variant",
    {
      p_clip_id: clipId,
      p_render_version: WATERMARK_RENDER_VERSION,
      p_processor: WATERMARK_PROCESSOR,
    },
  );
  if (typeof result === "boolean") return result;
  if (Array.isArray(result)) {
    const row = result[0];
    if (typeof row === "boolean") return row;
    if (row && typeof row.claim_watermark_variant === "boolean") return row.claim_watermark_variant;
  }
  return Boolean(result);
}

async function patchWatermark(
  env: Env,
  clipId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}`, {
    ...patch,
    watermark_updated_at: new Date().toISOString(),
  });
}

async function mintIngestToken(env: Env, clipId: string): Promise<string> {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + INGEST_TTL_MS).toISOString();
  await serviceRest(env, "POST", "/bunny_ingest_tokens", {
    token_hash: tokenHash,
    clip_id: clipId,
    expires_at: expiresAt,
  });
  return token;
}

export async function enqueueWatermarkVariant(
  env: Env,
  clipId: string,
  _request?: Request,
  options?: { force?: boolean },
): Promise<"skipped" | "already" | "submitted" | "failed"> {
  if (!bunnyConfigured(env)) return "skipped";
  requireServiceRole(env);

  const clips = await serviceRest<WatermarkClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${clipId}&select=id,user_id,slug,title,storage_key,height,watermark,watermark_variant_status,watermark_processor,watermark_processor_video_id,watermark_resolution,watermark_render_version,watermark_error,watermark_updated_at`,
  );
  const clip = clips[0];
  if (!clip) return "skipped";
  if (!clip.watermark && !options?.force) return "skipped";
  if (
    clip.watermark_variant_status === "submitting" ||
    clip.watermark_variant_status === "processing" ||
    (clip.watermark_variant_status === "ready" &&
      clip.watermark_render_version === WATERMARK_RENDER_VERSION &&
      clip.watermark_processor_video_id)
  ) {
    return "already";
  }

  // claim_watermark_variant requires watermark=true; flip the flag when forcing
  // a branded download for free downloaders of clean/premium-owned rows.
  if (options?.force && !clip.watermark) {
    await serviceRest(env, "PATCH", `/clips?id=eq.${clipId}`, { watermark: true });
    clip.watermark = true;
  }

  const claimed = await claimWatermarkJob(env, clipId);
  if (!claimed) return "already";

  try {
    if (!ownedObjectKey(clip.user_id, clip.storage_key)) {
      await patchWatermark(env, clipId, {
        watermark_variant_status: "failed",
        watermark_error: "invalid_storage_key",
      });
      return "failed";
    }

    const token = await mintIngestToken(env, clipId);
    const sourceUrl = `${bunnyIngestOrigin(env)}/internal/bunny-source/${token}`;
    const result = await fetchBunnyVideo(env, {
      url: sourceUrl,
      title: bunnyClipTitle(clipId),
    });

    const videoId = String(result.guid || result.id || "").trim() || null;
    await patchWatermark(env, clipId, {
      watermark_variant_status: "processing",
      watermark_processor: WATERMARK_PROCESSOR,
      watermark_processor_video_id: videoId,
      watermark_render_version: WATERMARK_RENDER_VERSION,
      watermark_error: null,
    });
    return "submitted";
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "bunny_submit_failed";
    await patchWatermark(env, clipId, {
      watermark_variant_status: "failed",
      watermark_error: message.slice(0, 500),
    });
    return "failed";
  }
}

export async function handleBunnySource(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  if (!/^[a-f0-9]{48,128}$/i.test(token)) {
    return json({ error: "Invalid token." }, 404);
  }
  requireServiceRole(env);
  requireR2(env);

  const tokenHash = await sha256Hex(token);
  const rows = await serviceRest<IngestTokenRow[]>(
    env,
    "GET",
    `/bunny_ingest_tokens?token_hash=eq.${tokenHash}&select=token_hash,clip_id,expires_at&limit=1`,
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return json({ error: "Token expired." }, 404);
  }

  const clips = await serviceRest<WatermarkClipRow[]>(
    env,
    "GET",
    `/clips?id=eq.${row.clip_id}&select=id,user_id,storage_key,watermark,status`,
  );
  const clip = clips[0] as WatermarkClipRow & { status?: string };
  if (!clip?.watermark || !ownedObjectKey(clip.user_id, clip.storage_key)) {
    return json({ error: "Clip not found." }, 404);
  }

  const signed = await r2Client(env).sign(`${objectUrl(env, clip.storage_key!)}?X-Amz-Expires=3600`, {
    method: "GET",
    aws: { signQuery: true },
  });
  const object = await fetch(signed.url);
  if (!object.ok || !object.body) {
    return json({ error: "Source unavailable." }, 502);
  }
  const headers = new Headers();
  // Force a video content-type so Bunny does not treat SPA/JSON mishits as source.
  headers.set("content-type", "video/mp4");
  headers.set("content-disposition", 'inline; filename="original.mp4"');
  const length = object.headers.get("content-length");
  if (length) headers.set("content-length", length);
  headers.set("cache-control", "no-store");
  headers.set("accept-ranges", "bytes");
  return new Response(object.body, { status: 200, headers });
}

async function markReadyFromVideo(env: Env, clip: WatermarkClipRow, videoId: string): Promise<void> {
  const video = await getBunnyVideo(env, videoId);
  // Video API: 4 = Finished, 5 = Error. Webhook uses different numbers.
  if (video.status === 5 || video.status === 6) {
    await patchWatermark(env, clip.id, {
      watermark_variant_status: "failed",
      watermark_processor_video_id: videoId,
      watermark_error: "bunny_encode_failed",
    });
    return;
  }
  if (video.status !== 4) {
    await patchWatermark(env, clip.id, {
      watermark_variant_status: "processing",
      watermark_processor_video_id: videoId,
      watermark_error: null,
    });
    return;
  }

  const resolutions = await getBunnyResolutions(env, videoId);
  const heights = parseMp4Heights(resolutions, video.availableResolutions);
  const picked = pickDownloadResolution(clip.height, heights);
  if (!picked.ok) {
    await patchWatermark(env, clip.id, {
      watermark_variant_status: "failed",
      watermark_processor_video_id: videoId,
      watermark_error: picked.error,
    });
    return;
  }

  await patchWatermark(env, clip.id, {
    watermark_variant_status: "ready",
    watermark_processor: WATERMARK_PROCESSOR,
    watermark_processor_video_id: videoId,
    watermark_resolution: picked.resolution,
    watermark_render_version: WATERMARK_RENDER_VERSION,
    watermark_error: null,
  });
}

export async function handleBunnyWebhook(request: Request, env: Env): Promise<Response> {
  requireServiceRole(env);
  const raw = await request.text();
  const readonlyKey = env.BUNNY_STREAM_READONLY_API_KEY?.trim() || "";
  const signature = request.headers.get("X-BunnyStream-Signature");
  if (!(await verifyBunnyWebhookSignature(raw, signature, readonlyKey))) {
    return json({ error: "Invalid signature." }, 401);
  }

  let body: { VideoLibraryId?: number | string; VideoGuid?: string; Status?: number };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const libraryId = String(env.BUNNY_STREAM_LIBRARY_ID || "");
  if (libraryId && String(body.VideoLibraryId ?? "") !== libraryId) {
    return json({ ok: true, ignored: "library" });
  }

  const videoId = String(body.VideoGuid || "").trim();
  if (!videoId) return json({ ok: true, ignored: "guid" });

  const status = Number(body.Status);
  // Webhook: 3 = Finished, 5 = Failed (Bunny Stream docs).
  if (status !== 3 && status !== 5) {
    return json({ ok: true, ignored: "status" });
  }

  let clip: WatermarkClipRow | null = null;
  const byVideo = await serviceRest<WatermarkClipRow[]>(
    env,
    "GET",
    `/clips?watermark_processor_video_id=eq.${encodeURIComponent(videoId)}&select=id,user_id,slug,title,storage_key,height,watermark,watermark_variant_status,watermark_processor,watermark_processor_video_id,watermark_resolution,watermark_render_version,watermark_error,watermark_updated_at&limit=1`,
  );
  clip = byVideo[0] ?? null;

  if (!clip) {
    try {
      const video = await getBunnyVideo(env, videoId);
      const clipId = parseClipIdFromBunnyTitle(video.title);
      if (clipId) {
        const rows = await serviceRest<WatermarkClipRow[]>(
          env,
          "GET",
          `/clips?id=eq.${clipId}&select=id,user_id,slug,title,storage_key,height,watermark,watermark_variant_status,watermark_processor,watermark_processor_video_id,watermark_resolution,watermark_render_version,watermark_error,watermark_updated_at&limit=1`,
        );
        clip = rows[0] ?? null;
      }
    } catch {
      return json({ ok: true, ignored: "unknown_video" });
    }
  }

  if (!clip || !clip.watermark) {
    return json({ ok: true, ignored: "not_replayr" });
  }

  if (status === 5) {
    await patchWatermark(env, clip.id, {
      watermark_variant_status: "failed",
      watermark_processor_video_id: videoId,
      watermark_error: "bunny_webhook_failed",
    });
    return json({ ok: true, status: "failed" });
  }

  try {
    await markReadyFromVideo(env, clip, videoId);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "verify_failed";
    await patchWatermark(env, clip.id, {
      watermark_variant_status: "failed",
      watermark_processor_video_id: videoId,
      watermark_error: message.slice(0, 500),
    });
  }
  return json({ ok: true });
}

export async function brandedDownloadRedirect(
  env: Env,
  clip: {
    watermark_processor_video_id: string | null;
    watermark_resolution: number | null;
  },
  filename?: string,
): Promise<Response> {
  const videoId = clip.watermark_processor_video_id?.trim();
  const resolution = Number(clip.watermark_resolution);
  if (!videoId || !Number.isFinite(resolution) || resolution <= 0) {
    throw new HttpError(502, "Branded download is not ready.");
  }
  const object = await fetchBunnyMp4(env, videoId, resolution);
  if (!object.ok || !object.body) {
    throw new HttpError(502, "Could not fetch branded download.");
  }
  const contentType = object.headers.get("content-type") || "";
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new HttpError(502, "Branded download returned a non-video response.");
  }
  if (contentType && !/video|octet-stream|mp4/i.test(contentType)) {
    throw new HttpError(502, "Branded download returned a non-video response.");
  }

  // Peek the first bytes so we never proxy Bunny hotlink-block HTML as an MP4.
  const reader = object.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.byteLength) {
    throw new HttpError(502, "Could not fetch branded download.");
  }
  const prefix = first.value;
  const head = new TextDecoder().decode(prefix.slice(0, Math.min(96, prefix.byteLength)));
  const trimmed = head.trimStart();
  const hasFtyp = (() => {
    const limit = Math.min(64, Math.max(0, prefix.byteLength - 3));
    for (let i = 0; i < limit; i += 1) {
      if (
        prefix[i] === 0x66 &&
        prefix[i + 1] === 0x74 &&
        prefix[i + 2] === 0x79 &&
        prefix[i + 3] === 0x70
      ) {
        return true;
      }
    }
    return false;
  })();
  if (trimmed.startsWith("<") || trimmed.startsWith("{") || !hasFtyp) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    throw new HttpError(502, "Branded download returned a non-video response.");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      return pump();
      async function pump(): Promise<void> {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          if (next.value) controller.enqueue(next.value);
        }
      }
    },
    cancel() {
      return reader.cancel();
    },
  });

  const headers = new Headers();
  headers.set("content-type", "video/mp4");
  headers.set(
    "content-disposition",
    `attachment; filename="${(filename || "clip.mp4").replace(/"/g, "")}"`,
  );
  const length = object.headers.get("content-length");
  if (length) headers.set("content-length", length);
  headers.set("cache-control", "private, no-store");
  return new Response(stream, { status: 200, headers });
}

export async function deleteBunnyAssetForClip(
  env: Env,
  videoId: string | null | undefined,
): Promise<void> {
  if (!videoId?.trim()) return;
  try {
    await deleteBunnyVideo(env, videoId.trim());
  } catch (caught) {
    console.error("bunny delete failed", caught instanceof Error ? caught.message : caught);
  }
}

export async function reconcileWatermarkJobs(env: Env): Promise<void> {
  if (!bunnyConfigured(env)) return;
  requireServiceRole(env);
  const now = Date.now();

  const stale = await serviceRest<WatermarkClipRow[]>(
    env,
    "GET",
    `/clips?watermark_variant_status=in.(submitting,processing)&select=id,user_id,slug,title,storage_key,height,watermark,watermark_variant_status,watermark_processor,watermark_processor_video_id,watermark_resolution,watermark_render_version,watermark_error,watermark_updated_at&order=watermark_updated_at.asc&limit=40`,
  );

  for (const clip of stale) {
    const updatedAt = clip.watermark_updated_at ? new Date(clip.watermark_updated_at).getTime() : 0;
    const age = now - updatedAt;
    if (clip.watermark_variant_status === "submitting" && age > STALE_SUBMITTING_MS) {
      await patchWatermark(env, clip.id, {
        watermark_variant_status: "failed",
        watermark_error: "stale_submitting",
      });
      continue;
    }
    if (clip.watermark_variant_status === "processing") {
      if (clip.watermark_processor_video_id) {
        try {
          await markReadyFromVideo(env, clip, clip.watermark_processor_video_id);
        } catch (caught) {
          if (age > STALE_PROCESSING_MS) {
            const message = caught instanceof Error ? caught.message : "stale_processing";
            await patchWatermark(env, clip.id, {
              watermark_variant_status: "failed",
              watermark_error: message.slice(0, 500),
            });
          }
        }
      } else if (age > STALE_PROCESSING_MS) {
        await patchWatermark(env, clip.id, {
          watermark_variant_status: "failed",
          watermark_error: "stale_processing_no_video",
        });
      }
    }
  }

  // Re-verify false "unavailable_mp4_resolution" failures after parser/CDN fixes.
  const falseFails = await serviceRest<WatermarkClipRow[]>(
    env,
    "GET",
    `/clips?watermark_variant_status=eq.failed&watermark_error=eq.unavailable_mp4_resolution&watermark_processor_video_id=not.is.null&select=id,user_id,slug,title,storage_key,height,watermark,watermark_variant_status,watermark_processor,watermark_processor_video_id,watermark_resolution,watermark_render_version,watermark_error,watermark_updated_at&order=watermark_updated_at.desc&limit=20`,
  );
  for (const clip of falseFails) {
    if (!clip.watermark_processor_video_id) continue;
    try {
      await markReadyFromVideo(env, clip, clip.watermark_processor_video_id);
    } catch {
      /* leave failed */
    }
  }

  // Expire old ingest tokens.
  await serviceRest(
    env,
    "DELETE",
    `/bunny_ingest_tokens?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
  );
}
