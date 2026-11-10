import fs from "node:fs";

const TRACK_ENABLED = 0x000001;
const TRACK_IN_MOVIE = 0x000002;

function be32(buf, o) {
  return buf.readUInt32BE(o);
}

function fourcc(buf, o) {
  return buf.subarray(o, o + 4).toString("latin1");
}

function walk(buf, start, end, acc = []) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = be32(buf, offset);
    const kind = fourcc(buf, offset + 4);
    let header = 8;
    if (size === 1) {
      header = 16;
      size = Number(buf.readBigUInt64BE(offset + 8));
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    acc.push({ kind, offset, header, size, payload: offset + header, end: offset + size });
    if (["moov", "trak", "mdia", "minf"].includes(kind)) {
      walk(buf, offset + header, offset + size, acc);
    }
    offset += size;
  }
  return acc;
}

function tracks(buf) {
  const topEnd = buf.length;
  const boxes = walk(buf, 0, topEnd);
  const found = [];
  let current = null;
  for (const box of boxes) {
    if (box.kind === "trak") {
      current = { tkhd: null, handler: null };
      found.push(current);
    }
    if (!current) continue;
    if (box.kind === "tkhd") current.tkhd = box;
    if (box.kind === "hdlr") current.handler = fourcc(buf, box.payload + 8);
  }
  return found;
}

function flagsOf(buf, tkhd) {
  return (buf[tkhd.payload + 1] << 16) | (buf[tkhd.payload + 2] << 8) | buf[tkhd.payload + 3];
}

function setFlags(buf, tkhd, flags) {
  buf[tkhd.payload + 1] = (flags >> 16) & 0xff;
  buf[tkhd.payload + 2] = (flags >> 8) & 0xff;
  buf[tkhd.payload + 3] = flags & 0xff;
}

function describe(buf) {
  return tracks(buf).map((track) => {
    const flags = flagsOf(buf, track.tkhd);
    return {
      handler: track.handler,
      flags,
      enabled: Boolean(flags & TRACK_ENABLED),
      in_movie: Boolean(flags & TRACK_IN_MOVIE),
    };
  });
}

const [, , src, dest, mode] = process.argv;
if (!src || !dest || !["video", "both"].includes(mode)) {
  console.error("usage: node mp4-patch-tkhd.mjs <src.mp4> <dest.mp4> <video|both>");
  process.exit(2);
}

const buf = Buffer.from(fs.readFileSync(src));
const before = describe(buf);
console.log("before", JSON.stringify(before));
for (const track of tracks(buf)) {
  if (!track.tkhd || !track.handler) continue;
  const patch = mode === "both" || track.handler === "vide";
  if (!patch) continue;
  if (track.handler !== "vide" && track.handler !== "soun") continue;
  const flags = flagsOf(buf, track.tkhd) | TRACK_ENABLED | TRACK_IN_MOVIE;
  setFlags(buf, track.tkhd, flags);
  console.log(`patched ${track.handler} flags -> 0x${flags.toString(16).padStart(6, "0")}`);
}
const after = describe(buf);
console.log("after", JSON.stringify(after));
fs.writeFileSync(dest, buf);
const out = fs.openSync(dest, "r+");
fs.fsyncSync(out);
fs.closeSync(out);
console.log(`wrote ${dest}`);
