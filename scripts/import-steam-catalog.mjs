// Steam's old GetAppList endpoint now returns 404, and IStoreService requires a Web API key.
// The live store search is games only and has current names (for example Counter-Strike 2).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STEAM_DIRECTORY_SKIP =
  /\b(?:soundtrack|downloadable content|dlc|demo|dedicated server|playtest|sdk|trailer|benchmark|wallpaper|artbook|original soundtrack|ost|bonus content)\b/i;

function steamDirectoryName(value) {
  const cleaned = String(value ?? "").replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 200) return null;
  if (!/[a-z]/i.test(cleaned) || STEAM_DIRECTORY_SKIP.test(cleaned)) return null;
  return cleaned;
}

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv(resolve("worker/.dev.vars"));
const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("worker/.dev.vars is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function upsertRows(rows) {
  const batchSize = 400;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const response = await fetch(`${supabaseUrl}/rest/v1/steam_apps?on_conflict=app_id`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      console.error(`Import batch failed (${response.status}) ${detail}`);
      process.exit(1);
    }
  }
}

const seen = new Set();
const pending = [];
let listed = 0;
let imported = 0;
let start = Number(process.env.STEAM_START || 0);
let total = Number.POSITIVE_INFINITY;
while (start < total) {
  const pageUrl = `https://store.steampowered.com/search/results/?query&start=${start}&count=100&infinite=1&category1=998&cc=US&l=english`;
  const response = await fetch(pageUrl, {
    headers: { accept: "application/json", "user-agent": "Replayr/catalog" },
  });
  if (response.status === 429) {
    console.log("Steam asked us to slow down; waiting");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8000));
    continue;
  }
  if (!response.ok) {
    console.error(`Steam store page failed (${response.status}) at ${start}`);
    process.exit(1);
  }
  const page = await response.json();
  total = Number(page.total_count) || start;
  const html = typeof page.results_html === "string" ? page.results_html : "";
  const blocks = html.split('data-ds-appid="').slice(1);
  if (blocks.length === 0) break;
  for (const block of blocks) {
    const appId = Number(/^(\d+)/.exec(block)?.[1]);
    const rawName = /<span class="title">([^<]+)<\/span>/.exec(block)?.[1];
    const name = steamDirectoryName(decodeHtml(rawName ?? ""));
    if (!name || !Number.isInteger(appId) || appId < 1 || appId > 2147483647 || seen.has(appId)) continue;
    seen.add(appId);
    pending.push({
      app_id: appId,
      name,
      cover_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
    });
  }
  start += blocks.length;
  listed = start;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  if (pending.length >= 2000) {
    const batch = pending.splice(0, pending.length);
    await upsertRows(batch);
    imported += batch.length;
    console.log(`imported ${imported}; listed ${listed} / ${total}`);
  }
}
if (pending.length > 0) {
  await upsertRows(pending);
  imported += pending.length;
}
console.log(`done ${imported}; listed ${listed} / ${total}`);
