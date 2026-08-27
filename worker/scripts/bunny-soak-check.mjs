/**
 * End-to-end soak checklist helper for free-tier branded downloads.
 * Run after Bunny secrets are installed and Wave B spike PASSes.
 *
 * Usage:
 *   node worker/scripts/bunny-soak-check.mjs <clipSlug> [accessToken]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {
  ...parseEnv(join(root, "worker", ".dev.vars")),
  ...process.env,
};

const slug = process.argv[2]?.trim();
const token = process.argv[3]?.trim() || env.SOAK_ACCESS_TOKEN?.trim();
const base = (env.PUBLIC_APP_URL?.includes("127.0.0.1")
  ? "https://www.replayr.tv"
  : env.PUBLIC_APP_URL || "https://www.replayr.tv"
).replace(/\/+$/, "");

if (!slug) {
  console.error("Usage: node worker/scripts/bunny-soak-check.mjs <clipSlug> [accessToken]");
  process.exit(2);
}

const headers = {
  accept: "application/octet-stream, application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

console.log(`Probing ${base}/v1/clips/${slug}/download …`);
for (let attempt = 1; attempt <= 12; attempt += 1) {
  const response = await fetch(`${base}/v1/clips/${slug}/download`, {
    headers,
    redirect: "manual",
  });
  console.log(`attempt ${attempt}: HTTP ${response.status}`);
  if (response.status === 202) {
    const body = await response.text();
    console.log(body);
    await sleep(5000);
    continue;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    console.log("Redirect Location:", location);
    if (!location) process.exit(1);
    const head = await fetch(location, { method: "HEAD" });
    console.log(`Branded MP4 HEAD -> ${head.status}`);
    process.exit(head.ok ? 0 : 1);
  }
  if (response.ok) {
    const type = response.headers.get("content-type") || "";
    console.log("Direct body content-type:", type);
    process.exit(type.includes("video") || type.includes("octet") ? 0 : 1);
  }
  console.error(await response.text());
  process.exit(1);
}
console.error("Still preparing after polls.");
process.exit(1);

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
