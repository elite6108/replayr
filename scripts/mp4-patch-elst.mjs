import crypto from "node:crypto";
import fs from "node:fs";

function be32(buf, o) {
  return buf.readUInt32BE(o);
}

function fourcc(buf, o) {
  return buf.subarray(o, o + 4).toString("latin1");
}

function headerSize(buf, offset, end) {
  const size32 = be32(buf, offset);
  if (size32 === 1) return { header: 16, size: Number(buf.readBigUInt64BE(offset + 8)) };
  if (size32 === 0) return { header: 8, size: end - offset };
  return { header: 8, size: size32 };
}

function parseSiblings(buf, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const { header, size } = headerSize(buf, offset, end);
    if (size < header || offset + size > end) break;
    boxes.push({
      kind: fourcc(buf, offset + 4),
      offset,
      header,
      size,
      raw: Buffer.from(buf.subarray(offset, offset + size)),
    });
    offset += size;
  }
  return boxes;
}

function tkhdDuration(raw) {
  const version = raw[8];
  return version === 1 ? Number(raw.readBigUInt64BE(36)) : be32(raw, 28);
}

function makeEdts(segmentDuration) {
  const box = Buffer.alloc(36);
  box.writeUInt32BE(36, 0);
  box.write("edts", 4, 4, "latin1");
  box.writeUInt32BE(28, 8);
  box.write("elst", 12, 4, "latin1");
  box.writeUInt32BE(0, 16);
  box.writeUInt32BE(1, 20);
  box.writeUInt32BE(segmentDuration >>> 0, 24);
  box.writeInt32BE(0, 28);
  box.writeInt16BE(1, 32);
  box.writeUInt16BE(0, 34);
  return box;
}

function wrap(kind, payload) {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + payload.length, 0);
  hdr.write(kind, 4, 4, "latin1");
  return Buffer.concat([hdr, payload]);
}

function patchStco(buf, delta) {
  const visit = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      const { header, size } = headerSize(buf, offset, end);
      if (size < header || offset + size > end) break;
      const kind = fourcc(buf, offset + 4);
      const payload = offset + header;
      if (kind === "stco" || kind === "co64") {
        const count = be32(buf, payload + 4);
        const wide = kind === "co64";
        const entry = wide ? 8 : 4;
        for (let i = 0; i < count; i++) {
          const pos = payload + 8 + i * entry;
          if (wide) buf.writeBigUInt64BE(buf.readBigUInt64BE(pos) + BigInt(delta), pos);
          else buf.writeUInt32BE(be32(buf, pos) + delta, pos);
        }
      }
      if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(kind)) {
        visit(payload, offset + size);
      }
      offset += size;
    }
  };
  visit(0, buf.length);
}

function mdatHash(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const { header, size } = headerSize(buf, offset, buf.length);
    if (fourcc(buf, offset + 4) === "mdat") {
      return crypto.createHash("sha256").update(buf.subarray(offset + header, offset + size)).digest("hex");
    }
    offset += size;
  }
  throw new Error("mdat not found");
}

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error("usage: node mp4-patch-elst.mjs <src.mp4> <dest.mp4>");
  process.exit(2);
}

const srcBuf = fs.readFileSync(src);
const top = parseSiblings(srcBuf, 0, srcBuf.length);
const moov = top.find((b) => b.kind === "moov");
const mdat = top.find((b) => b.kind === "mdat");
if (!moov || !mdat) throw new Error("need moov + mdat");

const moovKids = parseSiblings(moov.raw, moov.header, moov.size);
const rebuiltKids = [];
const inserted = [];

for (const child of moovKids) {
  if (child.kind !== "trak") {
    rebuiltKids.push(child.raw);
    continue;
  }
  const trakKids = parseSiblings(child.raw, child.header, child.size);
  if (trakKids.some((b) => b.kind === "edts")) {
    throw new Error("track already has edts");
  }
  const tkhd = trakKids.find((b) => b.kind === "tkhd");
  if (!tkhd) throw new Error("trak missing tkhd");
  const duration = tkhdDuration(tkhd.raw);
  const edts = makeEdts(duration);
  inserted.push({
    track_id: be32(tkhd.raw, tkhd.raw[8] === 1 ? 28 : 20),
    segment_duration: duration,
    version: 0,
    entry_count: 1,
    media_time: 0,
    media_rate_integer: 1,
    media_rate_fraction: 0,
  });
  const out = [];
  for (const box of trakKids) {
    out.push(box.raw);
    if (box.kind === "tkhd") out.push(edts);
  }
  rebuiltKids.push(wrap("trak", Buffer.concat(out)));
}

const newMoov = wrap("moov", Buffer.concat(rebuiltKids));
const prefix = Buffer.concat(top.filter((b) => b.kind !== "moov" && b.kind !== "mdat").map((b) => b.raw));
const delta = newMoov.length - moov.size;
const patchedMoov = Buffer.from(newMoov);
patchStco(patchedMoov, delta);
const out = Buffer.concat([
  prefix,
  patchedMoov,
  srcBuf.subarray(mdat.offset, mdat.offset + mdat.size),
]);

const srcHash = mdatHash(srcBuf);
const outHash = mdatHash(out);
if (srcHash !== outHash) throw new Error(`mdat hash changed ${srcHash} -> ${outHash}`);

fs.writeFileSync(dest, out);
const fd = fs.openSync(dest, "r+");
fs.fsyncSync(fd);
fs.closeSync(fd);

console.log(JSON.stringify({
  src,
  dest,
  bytes: out.length,
  moov_delta: delta,
  inserted,
  mdat_sha256: outHash,
}, null, 2));
