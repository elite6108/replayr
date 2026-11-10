/**
 * Retitle recovered local_clips that still use raw filenames (clip-123…).
 * Prefer "Game clip"-style when we can't recover the original; use a readable timestamp.
 * Also backfill duration/width/height when the moov atom is at the end of the file.
 *
 * Usage: node scripts/retitle-recovered-clips.mjs
 * Close Replayr first if the DB is locked.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(process.env.APPDATA, "tv.elite.replay", "replay.sqlite");
const db = new Database(dbPath);

function be32(buf, o) {
  return buf.readUInt32BE(o);
}
function be64(buf, o) {
  return Number(buf.readBigUInt64BE(o));
}
function fourcc(buf, o = 0) {
  return buf.subarray(o, o + 4).toString("latin1");
}

function readBoxHeader(buf, offset, end) {
  if (offset + 8 > end) return null;
  let size = be32(buf, offset);
  const kind = fourcc(buf, offset + 4);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = be64(buf, offset + 8);
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header) return null;
  return { size, kind, header };
}

function parseMvhd(payload) {
  if (payload.length < 20) return null;
  const ver = payload[0];
  if (ver === 1 && payload.length >= 32) {
    const timescale = be32(payload, 20);
    const duration = be64(payload, 24);
    if (timescale > 0) return Math.round((duration / timescale) * 1000);
  }
  if (ver === 0 && payload.length >= 20) {
    const timescale = be32(payload, 12);
    const duration = be32(payload, 16);
    if (timescale > 0) return Math.round((duration / timescale) * 1000);
  }
  return null;
}

function parseTkhdSize(payload) {
  if (payload.length < 4) return null;
  const ver = payload[0];
  const matrixOff = ver === 1 ? 88 : 76;
  if (payload.length < matrixOff + 8) return null;
  const width = be32(payload, matrixOff) >> 16;
  const height = be32(payload, matrixOff + 4) >> 16;
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function walkMoov(buf, start, end, out) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(buf, offset, end);
    if (!box || offset + box.size > end) break;
    const payloadOff = offset + box.header;
    const payloadEnd = offset + box.size;
    if (box.kind === "mvhd") {
      const ms = parseMvhd(buf.subarray(payloadOff, payloadEnd));
      if (ms != null) out.durationMs = ms;
    } else if (box.kind === "trak") {
      walkMoov(buf, payloadOff, payloadEnd, out);
    } else if (box.kind === "tkhd") {
      const size = parseTkhdSize(buf.subarray(payloadOff, payloadEnd));
      if (size && (!out.width || size.width * size.height > out.width * out.height)) {
        out.width = size.width;
        out.height = size.height;
      }
    } else if (box.kind === "mdia" || box.kind === "minf" || box.kind === "stbl") {
      walkMoov(buf, payloadOff, payloadEnd, out);
    }
    offset += box.size;
  }
}

/** Read head + tail so faststart and non-faststart MP4s both work. */
function probeMp4(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const headLen = Math.min(stat.size, 4 * 1024 * 1024);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(stat.size, 8 * 1024 * 1024);
    const tailStart = Math.max(0, stat.size - tailLen);
    const tail = Buffer.alloc(stat.size - tailStart);
    fs.readSync(fd, tail, 0, tail.length, tailStart);

    const out = { durationMs: null, width: null, height: null };
    for (const buf of [head, tail]) {
      let offset = 0;
      while (offset + 8 <= buf.length) {
        const box = readBoxHeader(buf, offset, buf.length);
        if (!box) break;
        if (box.kind === "moov") {
          const end = Math.min(offset + box.size, buf.length);
          walkMoov(buf, offset + box.header, end, out);
          break;
        }
        if (box.size > buf.length - offset) break;
        offset += box.size;
      }
      if (out.durationMs != null) break;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function formatTitle(date) {
  // e.g. "Clip · Sep 10, 2026 12:34 AM"
  const pretty = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Clip · ${pretty}`;
}

function looksLikeRawIdTitle(title, localId) {
  if (!title) return true;
  if (title === localId) return true;
  if (/^clip-\d+(-r\d+)?$/i.test(title)) return true;
  return false;
}

const rows = db
  .prepare("SELECT local_id, title, file_path, created_at, duration_ms, width, height FROM local_clips")
  .all();

const update = db.prepare(`
  UPDATE local_clips
  SET title = @title,
      duration_ms = COALESCE(@duration_ms, duration_ms),
      width = COALESCE(@width, width),
      height = COALESCE(@height, height)
  WHERE local_id = @local_id
`);

let retitled = 0;
let probed = 0;
const tx = db.transaction((list) => {
  for (const row of list) {
    let title = row.title;
    let changed = false;
    if (looksLikeRawIdTitle(title, row.local_id)) {
      const when = row.created_at ? new Date(row.created_at.replace(" ", "T") + "Z") : null;
      const date = when && !Number.isNaN(when.getTime()) ? when : fs.statSync(row.file_path).mtime;
      title = formatTitle(date);
      changed = true;
      retitled += 1;
    }

    let durationMs = row.duration_ms;
    let width = row.width;
    let height = row.height;
    if ((durationMs == null || width == null || height == null) && fs.existsSync(row.file_path)) {
      const meta = probeMp4(row.file_path);
      if (durationMs == null && meta.durationMs != null) {
        durationMs = meta.durationMs;
        changed = true;
        probed += 1;
      }
      if (width == null && meta.width != null) {
        width = meta.width;
        changed = true;
      }
      if (height == null && meta.height != null) {
        height = meta.height;
        changed = true;
      }
    }

    if (changed) {
      update.run({
        local_id: row.local_id,
        title,
        duration_ms: durationMs,
        width,
        height,
      });
    }
  }
});

tx(rows);
db.close();
console.log(`Retitled ${retitled} clips; backfilled duration on ${probed}. Restart Replayr / refresh Library.`);
