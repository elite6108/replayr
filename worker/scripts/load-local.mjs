// Local capacity probe for playback URL signing and game search.
// Refuses any host other than localhost or 127.0.0.1. This is not a hosted capacity number.

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const origin = new URL(base);
if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
  console.error("Refusing to load-test a non-local host.");
  process.exit(1);
}

const requests = 40;
const concurrency = 8;
const paths = ["/v1/games/search?q=replay", "/v1/clips/abcdef"];

async function probe(path) {
  const started = performance.now();
  const response = await fetch(new URL(path, origin));
  await response.arrayBuffer().catch(() => undefined);
  return { path, status: response.status, ms: performance.now() - started };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

for (const path of paths) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < requests) {
      const current = next;
      next += 1;
      results[current] = await probe(path);
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
      target: new URL(path, origin).toString(),
      requests,
      concurrency,
      elapsedMs: Math.round(elapsed),
      p95Ms: Math.round(percentile(times, 0.95)),
      statuses: Object.fromEntries(counts),
      note: "Local worker only. This does not measure hosted capacity.",
    }),
  );
}
