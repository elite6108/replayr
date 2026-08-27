import { describe, expect, it } from "vitest";
import { allowRateLimit } from "../src/rateLimit";

describe("allowRateLimit", () => {
  it("allows until the limit then rejects", () => {
    const key = `test-${Math.random()}`;
    expect(allowRateLimit(key, 2, 60_000)).toBe(true);
    expect(allowRateLimit(key, 2, 60_000)).toBe(true);
    expect(allowRateLimit(key, 2, 60_000)).toBe(false);
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
