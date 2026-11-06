import { describe, expect, it } from "vitest";
import { allowRateLimit, assertDistributedRateLimit, clearRateLimitBuckets } from "../src/rateLimit";

describe("allowRateLimit", () => {
  it("allows until the limit then rejects", () => {
    const key = `test-${Math.random()}`;
    expect(allowRateLimit(key, 2, 60_000)).toBe(true);
    expect(allowRateLimit(key, 2, 60_000)).toBe(true);
    expect(allowRateLimit(key, 2, 60_000)).toBe(false);
  });
});

describe("assertDistributedRateLimit", () => {
  it("stops the call on this instance before the distributed limiter", async () => {
    clearRateLimitBuckets();
    let calls = 0;
    const binding = {
      limit: async () => {
        calls += 1;
        return { success: true };
      },
    };
    const request = new Request("https://replayr.tv/v1/analytics/events", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    await assertDistributedRateLimit(request, binding, "instance-window", 1);
    await expect(assertDistributedRateLimit(request, binding, "instance-window", 1)).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toBe(1);
  });

  it("still consults the distributed limiter after the local window allows it", async () => {
    clearRateLimitBuckets();
    const request = new Request("https://replayr.tv/v1/analytics/events", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    });
    const binding = { limit: async () => ({ success: false }) };
    await expect(assertDistributedRateLimit(request, binding, "distributed-deny", 5)).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("mapPool (inline)", () => {
  it("preserves order with limited concurrency", async () => {
    async function mapPool<T, R>(
      items: T[],
      concurrency: number,
      worker: (item: T, index: number) => Promise<R>,
    ): Promise<R[]> {
      const results = new Array<R>(items.length);
      let next = 0;
      const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
        while (true) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      });
      await Promise.all(runners);
      return results;
    }

    const result = await mapPool([1, 2, 3, 4], 2, async (value, index) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value * 10 + index;
    });
    expect(result).toEqual([10, 21, 32, 43]);
  });
});
