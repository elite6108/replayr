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

function makeFtyp({ major, minor, brands }) {
  const payload = Buffer.alloc(8 + brands.length * 4);
  payload.write(major, 0, 4, "latin1");
  payload.writeUInt32BE(minor >>> 0, 4);
  for (let i = 0; i < brands.length; i++) payload.write(brands[i], 8 + i * 4, 4, "latin1");
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, 4, "latin1");
  payload.copy(box, 8);
  return box;
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
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(kind)) visit(payload, offset + size);
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
  console.error("usage: node mp4-patch-ftyp.mjs <src.mp4> <dest.mp4>");
  process.exit(2);
}

const srcBuf = fs.readFileSync(src);
const top = parseSiblings(srcBuf, 0, srcBuf.length);
const ftyp = top.find((b) => b.kind === "ftyp");
const moov = top.find((b) => b.kind === "moov");
const mdat = top.find((b) => b.kind === "mdat");
if (!ftyp || !moov || !mdat) throw new Error("need ftyp + moov + mdat");

const newFtyp = makeFtyp({
  major: "isom",
  minor: 512,
  brands: ["isom", "iso2", "avc1", "mp41"],
});
const delta = newFtyp.length - ftyp.size;
const rest = Buffer.from(srcBuf.subarray(ftyp.size));
patchStco(rest, delta);
const out = Buffer.concat([newFtyp, rest]);

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
  ftyp_delta: delta,
  mdat_sha256: outHash,
}, null, 2));
