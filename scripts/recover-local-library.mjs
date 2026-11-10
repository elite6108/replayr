/**
 * Re-register MP4 files from the save folder into local_clips when the index was wiped.
 * Usage: node scripts/recover-local-library.mjs
 * Close Replayr first so the DB is not locked.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(process.env.APPDATA, "tv.elite.replay", "replay.sqlite");
if (!fs.existsSync(dbPath)) {
  throw new Error(`Missing database at ${dbPath}`);
}

function be32(buf, o) {
  return buf.readUInt32BE(o);
}
function be64(buf, o) {
  return Number(buf.readBigUInt64BE(o));
}
function fourcc(buf, o = 0) {
  return buf.subarray(o, o + 4).toString("latin1");
}

/** Best-effort duration (ms) + size from a local MP4. */
function probeMp4(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const chunk = Buffer.alloc(Math.min(stat.size, 8 * 1024 * 1024));
    fs.readSync(fd, chunk, 0, chunk.length, 0);
    let offset = 0;
    let durationMs = null;
    let width = null;
    let height = null;
    while (offset + 8 <= chunk.length) {
      let size = be32(chunk, offset);
      const kind = fourcc(chunk, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > chunk.length) break;
        size = be64(chunk, offset + 8);
        header = 16;
      } else if (size === 0) {
        size = chunk.length - offset;
      }
      if (size < header) break;
      const payload = offset + header;
      if (kind === "moov") {
        const end = Math.min(offset + size, chunk.length);
        let o = payload;
        while (o + 8 <= end) {
          let s = be32(chunk, o);
          const k = fourcc(chunk, o + 4);
          let h = 8;
          if (s === 1) {
            if (o + 16 > end) break;
            s = be64(chunk, o + 8);
            h = 16;
          }
          if (s < h || o + s > end) break;
          if (k === "mvhd") {
            const ver = chunk[o + h];
            if (ver === 1 && o + h + 32 <= end) {
              const timescale = be32(chunk, o + h + 20);
              const duration = be64(chunk, o + h + 24);
              if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
            } else if (ver === 0 && o + h + 20 <= end) {
              const timescale = be32(chunk, o + h + 12);
              const duration = be32(chunk, o + h + 16);
              if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
            }
          }
          if (k === "trak") {
            // Find tkhd width/height (16.16 fixed)
            let t = o + h;
            const trakEnd = o + s;
            while (t + 8 <= trakEnd) {
              let ts = be32(chunk, t);
              const tk = fourcc(chunk, t + 4);
              let th = 8;
              if (ts === 1) {
                if (t + 16 > trakEnd) break;
                ts = be64(chunk, t + 8);
                th = 16;
              }
              if (ts < th || t + ts > trakEnd) break;
              if (tk === "tkhd") {
                const ver = chunk[t + th];
                const matrixOff = ver === 1 ? t + th + 88 : t + th + 76;
                if (matrixOff + 8 <= trakEnd) {
                  const w = be32(chunk, matrixOff) >> 16;
                  const h = be32(chunk, matrixOff + 4) >> 16;
                  if (w > 0 && h > 0 && (!width || w * h > width * height)) {
                    width = w;
                    height = h;
                  }
                }
              }
              t += ts;
            }
          }
          o += s;
        }
        break;
      }
      if (kind === "mdat" && size > chunk.length) break;
      offset += size;
    }
    return { durationMs, width, height, fileSize: stat.size, mtime: stat.mtime };
  } finally {
    fs.closeSync(fd);
  }
}

function walkMp4s(root, out = [], depth = 0) {
  if (depth > 4 || !fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkMp4s(full, out, depth + 1);
    else if (name.toLowerCase().endsWith(".mp4")) out.push(full);
  }
  return out;
}

function localIdFor(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  if (/^clip-\d+$/i.test(base)) return base;
  const safe = base.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `clip-recovered-${safe || Date.now()}`;
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const docRow = db.prepare("SELECT value FROM settings WHERE key = ?").get("document");
const doc = docRow ? JSON.parse(docRow.value) : {};
const saveRoot =
  (typeof doc.saveLocation === "string" && doc.saveLocation.trim()) ||
  path.join(process.env.USERPROFILE, "Videos", "Project Replay");

const before = db.prepare("SELECT COUNT(*) AS n FROM local_clips").get().n;
const files = walkMp4s(saveRoot).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
console.log(`DB: ${dbPath}`);
console.log(`Save folder: ${saveRoot}`);
console.log(`Existing local_clips: ${before}`);
console.log(`MP4 files found: ${files.length}`);

const insert = db.prepare(`
  INSERT INTO local_clips (
    local_id, cloud_clip_id, file_path, thumbnail_path, game_id, created_at,
    duration_ms, width, height, fps, file_size, upload_status, favorite, title, description,
    source_clip_id, source_start_ms, source_end_ms, editor_crop_x
  ) VALUES (
    @local_id, NULL, @file_path, NULL, NULL, @created_at,
    @duration_ms, @width, @height, @fps, @file_size, 'local', 0, @title, NULL,
    NULL, NULL, NULL, 0.5
  )
`);
const existsId = db.prepare("SELECT 1 AS ok FROM local_clips WHERE local_id = ?");
const existsPath = db.prepare("SELECT 1 AS ok FROM local_clips WHERE file_path = ?");

const insertSource = db.prepare(`
  INSERT OR IGNORE INTO clip_sources (
    clip_id, source_instance_id, kind, file_path, role, start_hns, duration_hns,
    width, height, fps, health, layout_json, created_at
  ) VALUES (
    @clip_id, @source_instance_id, 'gameplay', @file_path, 'primary', 0, @duration_hns,
    @width, @height, @fps, 'ok', NULL, @created_at
  )
`);

let added = 0;
let skipped = 0;
const recover = db.transaction((list) => {
  for (const filePath of list) {
    if (existsPath.get(filePath)) {
      skipped += 1;
      continue;
    }
    let localId = localIdFor(filePath);
    if (existsId.get(localId)) {
      localId = `${localId}-r${added + 1}`;
    }
    const meta = probeMp4(filePath);
    const createdAt = meta.mtime.toISOString().replace("T", " ").replace("Z", "");
    const title = path.basename(filePath, path.extname(filePath));
    const durationHns =
      meta.durationMs != null ? Math.round(meta.durationMs * 10000) : null;
    insert.run({
      local_id: localId,
      file_path: filePath,
      created_at: createdAt,
      duration_ms: meta.durationMs,
      width: meta.width,
      height: meta.height,
      fps: 60,
      file_size: meta.fileSize,
      title,
    });
    try {
      insertSource.run({
        clip_id: localId,
        source_instance_id: `${localId}-gameplay`,
        file_path: filePath,
        duration_hns: durationHns,
        width: meta.width,
        height: meta.height,
        fps: 60,
        created_at: createdAt,
      });
    } catch {
      // Older DBs without clip_sources or constraint issues — clips row is enough.
    }
    added += 1;
  }
});

recover(files);
const after = db.prepare("SELECT COUNT(*) AS n FROM local_clips").get().n;
db.close();
console.log(`Added ${added}, skipped existing ${skipped}, local_clips now ${after}`);
console.log("Restart Replayr and open Library.");
