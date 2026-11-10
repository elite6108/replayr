/**
 * Restore recovered local_clips titles from cloud (ELITE account) by matching file size.
 * Falls back to filename slug → "{Game} clip" for unmatched gameplay files.
 *
 * Usage: node scripts/restore-titles-from-cloud.mjs [cloud.json]
 * Close Replayr first if the DB is locked.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(process.env.APPDATA, "tv.elite.replay", "replay.sqlite");

const SLUG_TITLES = {
  roblox: "Roblox clip",
  fivem: "FiveM clip",
  "gta-v": "Grand Theft Auto V clip",
  gta: "Grand Theft Auto V clip",
  recording: "Recording",
  display: "Display clip",
  clip: null, // keep looking
};

function isJunkPath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return (
    base.includes("-webcam") ||
    base.includes(".diag") ||
    base.includes(".upload") ||
    base.includes(".ffmpeg") ||
    base.includes(".gpu") ||
    base.includes(".compose") ||
    base.includes(".bitrate") ||
    base.includes(".faststart")
  );
}

function needsTitleFix(title) {
  if (!title) return true;
  if (/^clip-\d+/i.test(title)) return true;
  if (/^Clip · /.test(title)) return true;
  if (/^(recording|roblox|fivem|display)-\d+/i.test(title)) return true;
  return false;
}

function titleFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const m = base.match(/^([a-z0-9-]+?)-\d+/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SLUG_TITLES, slug)) {
    return SLUG_TITLES[slug];
  }
  // "grand-theft-auto-v" → "Grand Theft Auto V clip"
  const pretty = slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return pretty ? `${pretty} clip` : null;
}

function loadCloud(jsonPath) {
  let raw = fs.readFileSync(jsonPath, "utf8").trim();
  // MCP tool dumps often wrap the array in {"result":"...untrusted-data...[...]"}.
  try {
    const outer = JSON.parse(raw);
    if (typeof outer?.result === "string") raw = outer.result;
    else if (Array.isArray(outer)) return outer;
  } catch {
    // plain text / fence-wrapped
  }
  // Prefer the fenced JSON array (ignore prose that mentions the same tag name).
  const fence = raw.match(/<untrusted-data-[^>]+>\s*(\[[\s\S]*?\])\s*<\/untrusted-data-[^>]+>/);
  const payload = (fence ? fence[1] : raw).trim();
  const parsed = JSON.parse(payload);
  if (!Array.isArray(parsed)) throw new Error("Cloud JSON must be an array");
  return parsed;
}

const cloudArg =
  process.argv[2] ||
  path.join(
    process.env.USERPROFILE,
    ".cursor",
    "projects",
    "c-Users-gordo-Elite-Tv",
    "agent-tools",
    "9b67df95-69a9-4ba6-b231-3f0a1135a1d1.txt",
  );

const cloud = loadCloud(cloudArg);
const bySize = new Map();
const byDuration = new Map();
for (const row of cloud) {
  if (row.file_size_bytes != null) {
    const key = String(row.file_size_bytes);
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(row);
  }
  if (row.duration_ms != null) {
    const key = String(row.duration_ms);
    if (!byDuration.has(key)) byDuration.set(key, []);
    byDuration.get(key).push(row);
  }
}

function pickClosest(candidates, localCreatedAt) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const localMs = Date.parse(String(localCreatedAt).replace(" ", "T") + "Z");
  return [...candidates].sort((a, b) => {
    const da = Math.abs(Date.parse(a.created_at) - localMs);
    const dbv = Math.abs(Date.parse(b.created_at) - localMs);
    return da - dbv;
  })[0];
}

function findCloudHit(row) {
  const size = row.file_size != null ? Number(row.file_size) : null;
  if (size != null && bySize.has(String(size))) {
    const candidates = bySize.get(String(size)).filter((c) => !usedCloud.has(c.id));
    const hit = pickClosest(candidates, row.created_at);
    if (hit) return hit;
  }
  // Fallback: exact duration + created_at within 15 minutes.
  if (row.duration_ms != null && byDuration.has(String(row.duration_ms))) {
    const localMs = Date.parse(String(row.created_at).replace(" ", "T") + "Z");
    const candidates = byDuration
      .get(String(row.duration_ms))
      .filter((c) => !usedCloud.has(c.id))
      .filter((c) => Math.abs(Date.parse(c.created_at) - localMs) <= 15 * 60 * 1000);
    const hit = pickClosest(candidates, row.created_at);
    if (hit) return hit;
  }
  // Last resort: nearest unused cloud clip within 10 minutes of local mtime
  // (upload often happens shortly after save; file size may differ after watermark).
  {
    const localMs = Date.parse(String(row.created_at).replace(" ", "T") + "Z");
    if (!Number.isNaN(localMs)) {
      const windowMs = 10 * 60 * 1000;
      const candidates = cloud
        .filter((c) => !usedCloud.has(c.id))
        .filter((c) => Math.abs(Date.parse(c.created_at) - localMs) <= windowMs);
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        const hit = pickClosest(candidates, row.created_at);
        const delta = Math.abs(Date.parse(hit.created_at) - localMs);
        if (delta <= 2 * 60 * 1000) return hit;
      }
    }
  }
  return null;
}

const db = new Database(dbPath);
const rows = db
  .prepare(
    "SELECT local_id, title, file_path, file_size, duration_ms, created_at, cloud_clip_id, game_id FROM local_clips",
  )
  .all();

const update = db.prepare(`
  UPDATE local_clips
  SET title = @title,
      game_id = COALESCE(@game_id, game_id),
      cloud_clip_id = COALESCE(@cloud_clip_id, cloud_clip_id),
      upload_status = CASE
        WHEN @cloud_clip_id IS NOT NULL THEN 'uploaded'
        ELSE upload_status
      END
  WHERE local_id = @local_id
`);

let matched = 0;
let inferred = 0;
let skippedJunk = 0;
let unchanged = 0;
const usedCloud = new Set();

const tx = db.transaction((list) => {
  for (const row of list) {
    if (isJunkPath(row.file_path)) {
      skippedJunk += 1;
      continue;
    }
    if (!needsTitleFix(row.title) && row.cloud_clip_id) {
      unchanged += 1;
      continue;
    }

    const cloudHit = findCloudHit(row);
    if (cloudHit) {
      usedCloud.add(cloudHit.id);
      update.run({
        local_id: row.local_id,
        title: cloudHit.title || row.title,
        game_id: cloudHit.game_slug || null,
        cloud_clip_id: cloudHit.id,
      });
      matched += 1;
      continue;
    }

    if (needsTitleFix(row.title)) {
      const inferredTitle = titleFromFilename(row.file_path);
      if (inferredTitle) {
        update.run({
          local_id: row.local_id,
          title: inferredTitle,
          game_id: null,
          cloud_clip_id: null,
        });
        inferred += 1;
        continue;
      }
    }

    unchanged += 1;
  }
});

tx(rows);
db.close();

console.log(
  JSON.stringify(
    { matched, inferred, skippedJunk, unchanged, cloudRows: cloud.length, dbPath },
    null,
    2,
  ),
);
