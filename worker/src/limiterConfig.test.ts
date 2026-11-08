import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowAllLimiters } from "./rateLimit";

const root = dirname(fileURLToPath(import.meta.url));

describe("rate limiter bindings", () => {
  it("keeps wrangler, the env type, and the test stub on the same bindings", () => {
    const toml = readFileSync(join(root, "../wrangler.toml"), "utf8");
    const env = readFileSync(join(root, "env.ts"), "utf8");
    const comments = new Map<string, { namespace: string; limit: string }>();
    for (const line of toml.split(/\r?\n/)) {
      const match = /^# ([A-Z0-9_]+_RATE_LIMITER) (\d+) .+, (\d+)\/min$/.exec(line);
      if (!match) continue;
      expect(comments.has(match[1]), match[1]).toBe(false);
      comments.set(match[1], { namespace: match[2], limit: match[3] });
    }

    const declared = new Map<string, { namespace: string; limit: string; period: string }>();
    for (const block of toml.split("[[ratelimits]]").slice(1)) {
      const name = /name = "([^"]+)"/.exec(block)?.[1];
      const namespace = /namespace_id = "(\d+)"/.exec(block)?.[1];
      const limit = /simple = \{ limit = (\d+), period = (\d+) \}/.exec(block);
      expect(name).toBeTruthy();
      expect(namespace).toBeTruthy();
      expect(limit).toBeTruthy();
      expect(declared.has(name ?? "")).toBe(false);
      declared.set(name ?? "", { namespace: namespace ?? "", limit: limit?.[1] ?? "", period: limit?.[2] ?? "" });
    }

    const envFields = [...env.matchAll(/^\s+([A-Z0-9_]+_RATE_LIMITER)\?:/gm)].map((match) => match[1]);
    const stubs = Object.keys(allowAllLimiters());
    const names = [...comments.keys()].sort();

    expect(names).toEqual([...declared.keys()].sort());
    expect(names).toEqual([...envFields].sort());
    expect(names).toEqual([...stubs].sort());
    expect(new Set(envFields).size).toBe(envFields.length);
    expect(names).toHaveLength(20);

    const namespaces = names.map((name) => declared.get(name)?.namespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(namespaces.sort()).toEqual(Array.from({ length: 20 }, (_, index) => String(1001 + index)));

    for (const name of names) {
      const comment = comments.get(name);
      const binding = declared.get(name);
      expect(binding?.namespace).toBe(comment?.namespace);
      expect(binding?.limit).toBe(comment?.limit);
      expect(binding?.period).toBe("60");
    }
  });
});
