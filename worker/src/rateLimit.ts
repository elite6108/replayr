import { HttpError } from "./http";

/** Sliding-window rate limits keyed by client IP (and optional user id). */

const buckets = new Map<string, number[]>();

export function allowRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const next = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);
  if (next.length >= limit) {
    buckets.set(key, next);
    return false;
  }
  next.push(now);
  buckets.set(key, next);
  return true;
}

export function clientKey(request: Request, suffix: string, userId?: string): string {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  return userId ? `${suffix}:${userId}:${ip}` : `${suffix}:${ip}`;
}

export function clearRateLimitBuckets(): void {
  buckets.clear();
}

export function assertRateLimit(
  request: Request,
  suffix: string,
  limit: number,
  userId?: string,
  windowMs = 60_000,
): void {
  if (!allowRateLimit(clientKey(request, suffix, userId), limit, windowMs)) {
    throw new HttpError(429, "Slow down. Try again in a moment.");
  }
}

export async function assertDistributedRateLimit(
  request: Request,
  binding: { limit(input: { key: string }): Promise<{ success: boolean }> } | undefined,
  suffix: string,
  fallbackLimit: number,
  userId?: string,
  windowMs = 60_000,
): Promise<void> {
  const key = clientKey(request, suffix, userId);
  // Each isolate keeps its own window, then the shared Cloudflare limiter must allow it.
  if (!allowRateLimit(key, fallbackLimit, windowMs)) {
    throw new HttpError(429, "Slow down. Try again in a moment.");
  }
  if (!binding) throw new HttpError(503, "Rate limiting is not configured.");
  const result = await binding.limit({ key });
  if (!result.success) throw new HttpError(429, "Slow down. Try again in a moment.");
}

type RateLimiterBinding = { limit(input: { key: string }): Promise<{ success: boolean }> };

/** Allow-all binding for route tests. Production requests fail closed when a binding is missing. */
export function allowAllLimiters(): {
  ANALYTICS_RATE_LIMITER: RateLimiterBinding;
  ANALYTICS_REVEAL_RATE_LIMITER: RateLimiterBinding;
  SITE_ACCESS_RATE_LIMITER: RateLimiterBinding;
  WAITLIST_RATE_LIMITER: RateLimiterBinding;
  AI_TRANSCRIBE_RATE_LIMITER: RateLimiterBinding;
  WRITE_60_RATE_LIMITER: RateLimiterBinding;
  WRITE_30_RATE_LIMITER: RateLimiterBinding;
  WRITE_20_RATE_LIMITER: RateLimiterBinding;
  WRITE_10_RATE_LIMITER: RateLimiterBinding;
  WRITE_5_RATE_LIMITER: RateLimiterBinding;
  PLAYBACK_RATE_LIMITER: RateLimiterBinding;
  GAME_SEARCH_RATE_LIMITER: RateLimiterBinding;
  ACCOUNT_DELETE_RATE_LIMITER: RateLimiterBinding;
  PRESENCE_ANON_RATE_LIMITER: RateLimiterBinding;
  PRESENCE_AUTH_RATE_LIMITER: RateLimiterBinding;
  PUBLIC_FOLDER_RATE_LIMITER: RateLimiterBinding;
  PUBLIC_FOLDER_PLAY_RATE_LIMITER: RateLimiterBinding;
  PUBLIC_FOLDER_DOWNLOAD_RATE_LIMITER: RateLimiterBinding;
  PUBLIC_MISS_RATE_LIMITER: RateLimiterBinding;
  PUBLIC_FEED_RATE_LIMITER: RateLimiterBinding;
} {
  const binding = { limit: async () => ({ success: true }) };
  return {
    ANALYTICS_RATE_LIMITER: binding,
    ANALYTICS_REVEAL_RATE_LIMITER: binding,
    SITE_ACCESS_RATE_LIMITER: binding,
    WAITLIST_RATE_LIMITER: binding,
    AI_TRANSCRIBE_RATE_LIMITER: binding,
    WRITE_60_RATE_LIMITER: binding,
    WRITE_30_RATE_LIMITER: binding,
    WRITE_20_RATE_LIMITER: binding,
    WRITE_10_RATE_LIMITER: binding,
    WRITE_5_RATE_LIMITER: binding,
    PLAYBACK_RATE_LIMITER: binding,
    GAME_SEARCH_RATE_LIMITER: binding,
    ACCOUNT_DELETE_RATE_LIMITER: binding,
    PRESENCE_ANON_RATE_LIMITER: binding,
    PRESENCE_AUTH_RATE_LIMITER: binding,
    PUBLIC_FOLDER_RATE_LIMITER: binding,
    PUBLIC_FOLDER_PLAY_RATE_LIMITER: binding,
    PUBLIC_FOLDER_DOWNLOAD_RATE_LIMITER: binding,
    PUBLIC_MISS_RATE_LIMITER: binding,
    PUBLIC_FEED_RATE_LIMITER: binding,
  };
}
