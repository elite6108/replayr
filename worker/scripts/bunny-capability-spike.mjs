/**
 * Wave B capability spike: ingest a 1080p source into the production Bunny library
 * and verify play_1080p.mp4 exists with MP4 resolutions.
 *
 * Usage (from repo root, after secrets are in worker/.dev.vars or env):
 *   node worker/scripts/bunny-capability-spike.mjs [sourceMp4Url]
 *
 * Pass criteria: mp4Resolutions includes 1080 (or availableResolutions) and
 * HEAD/GET of play_1080p.mp4 succeeds. Deletes the spike video afterward.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {
  ...parseEnv(join(root, ".env")),
  ...parseEnv(join(root, ".env.cloudflare")),
  ...parseEnv(join(root, "worker", ".dev.vars")),
  ...process.env,
};

const libraryId = env.BUNNY_STREAM_LIBRARY_ID?.trim();
const apiKey = env.BUNNY_STREAM_API_KEY?.trim();
const cdn = env.BUNNY_STREAM_CDN_HOSTNAME?.trim()?.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
const sourceUrl = process.argv[2]?.trim();

if (!libraryId || !apiKey || !cdn) {
  console.error(
    "Missing BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY / BUNNY_STREAM_CDN_HOSTNAME. Add them to worker/.dev.vars (or Wrangler secrets) and re-run.",
  );
  process.exit(2);
}

if (!sourceUrl || !/^https:\/\//i.test(sourceUrl)) {
  console.error("Pass a public https:// URL to a known 1080p MP4 as argv[2].");
  process.exit(2);
}

const title = `replayr-spike:${Date.now()}`;
console.log("Creating fetch job…", { libraryId, cdn, title, sourceUrl });

const fetchRes = await bunny("POST", "/videos/fetch", {
  url: sourceUrl,
  title,
});
console.log("Fetch response:", fetchRes);

let videoId = String(fetchRes.guid || fetchRes.id || "").trim();
if (!videoId) {
  console.log("No guid in fetch response; polling recent library videos by title…");
  for (let i = 0; i < 30; i += 1) {
    await sleep(5000);
    const list = await bunny("GET", "/videos?page=1&itemsPerPage=20&orderBy=date");
    const items = list.items || list || [];
    const match = (Array.isArray(items) ? items : []).find((item) => item.title === title);
    if (match?.guid) {
      videoId = match.guid;
      break;
    }
    process.stdout.write(".");
  }
  console.log("");
}

if (!videoId) {
  console.error("FAIL: could not resolve Bunny video guid for spike.");
  process.exit(1);
}

console.log("Video guid:", videoId);

let finished = false;
for (let i = 0; i < 60; i += 1) {
  const video = await bunny("GET", `/videos/${videoId}`);
  console.log(`status=${video.status} encodeProgress=${video.encodeProgress} height=${video.height}`);
  // Video API: 4 = Finished, 5 = Error
  if (video.status === 4) {
    finished = true;
    break;
  }
  if (video.status === 5 || video.status === 6) {
    console.error("FAIL: Bunny encode failed", video);
    await cleanup(videoId);
    process.exit(1);
  }
  await sleep(10000);
}

if (!finished) {
  console.error("FAIL: timed out waiting for Finished status.");
  await cleanup(videoId);
  process.exit(1);
}

const resolutions = await bunny("GET", `/videos/${videoId}/resolutions`);
console.log("Resolutions payload:", JSON.stringify(resolutions, null, 2));
const heights = new Set();
for (const item of resolutions.mp4Resolutions || []) {
  const h = Number(item.height);
  if (Number.isFinite(h)) heights.add(h);
  const m = String(item.resolution || item.path || "").match(/(\d{3,4})/);
  if (m) heights.add(Number(m[1]));
}
for (const raw of resolutions.availableResolutions || []) {
  const m = String(raw).match(/(\d{3,4})/);
  if (m) heights.add(Number(m[1]));
}
const list = [...heights].sort((a, b) => b - a);
console.log("Parsed MP4 heights:", list);

const mp4Url = `https://${cdn}/${videoId}/play_1080p.mp4`;
const head = await fetch(mp4Url, { method: "HEAD" });
console.log(`HEAD ${mp4Url} -> ${head.status}`);

const pass = list.includes(1080) && head.ok;
await cleanup(videoId);

if (pass) {
  console.log("PASS: 1080p MP4 is available. Wave C download migration is unblocked.");
  process.exit(0);
}

console.error(
  "FAIL: play_1080p.mp4 not confirmed. Do not assume 1080 downloads. Review library MP4 Fallback / single-resolution settings.",
);
process.exit(1);

async function cleanup(id) {
  try {
    await bunny("DELETE", `/videos/${id}`);
    console.log("Deleted spike video", id);
  } catch (err) {
    console.warn("Could not delete spike video:", err instanceof Error ? err.message : err);
  }
}

async function bunny(method, path, body) {
  const response = await fetch(`https://video.bunnycdn.com/library/${libraryId}${path}`, {
    method,
    headers: {
      AccessKey: apiKey,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`Bunny ${method} ${path} -> ${response.status}: ${text}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnv(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      if (split < 1) continue;
      out[trimmed.slice(0, split)] = trimmed.slice(split + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}
