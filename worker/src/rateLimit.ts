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
