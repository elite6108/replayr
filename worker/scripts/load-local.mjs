// Local capacity probe. Refuses any host other than localhost or 127.0.0.1.
// Presence and upload continuation are omitted unless --include-writes is passed,
// because a local worker can still be pointed at a hosted database.
// This is not a hosted capacity number.

const args = process.argv.slice(2).filter((arg) => arg !== "--include-writes");
const includeWrites = process.argv.includes("--include-writes");
const base = args[0] ?? "http://127.0.0.1:8787";
const origin = new URL(base);
if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
  console.error("Refusing to load-test a non-local host.");
  process.exit(1);
}

const requests = 40;
const concurrency = 8;
const probes = [
  { method: "GET", path: "/v1/games/search?q=replay" },
  { method: "GET", path: "/v1/clips/abcdef" },
  { method: "GET", path: "/v1/games/catalog" },
];
if (includeWrites) {
  probes.push(
    { method: "POST", path: "/v1/presence/ping", body: JSON.stringify({ path: "/" }) },
    {
      method: "POST",
      path: "/v1/clips/11111111-1111-4111-8111-111111111111/upload-parts",
      body: JSON.stringify({ partNumbers: [1] }),
    },
  );
}

async function probe(item) {
  const started = performance.now();
  const response = await fetch(new URL(item.path, origin), {
    method: item.method,
    headers: item.body ? { "content-type": "application/json" } : undefined,
    body: item.body,
  });
  await response.arrayBuffer().catch(() => undefined);
  return { path: item.path, status: response.status, ms: performance.now() - started };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

for (const item of probes) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < requests) {
      const current = next;
      next += 1;
      results[current] = await probe(item);
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = performance.now() - started;
  const counts = new Map();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  const times = results.map((result) => result.ms);
  console.log(
    JSON.stringify({
      target: new URL(item.path, origin).toString(),
      method: item.method,
      requests,
      concurrency,
      elapsedMs: Math.round(elapsed),
      p95Ms: Math.round(percentile(times, 0.95)),
      statuses: Object.fromEntries(counts),
      note: "Local worker only. This does not measure hosted capacity.",
    }),
  );
}
