import crypto from "node:crypto";
import fs from "node:fs";

const MAX_VIDEO_PER_CHUNK = 2;
const COMMON_HZ = 240000;

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

function walk(buf, start, end, acc = []) {
  let offset = start;
  while (offset + 8 <= end) {
    const { header, size } = headerSize(buf, offset, end);
    if (size < header || offset + size > end) break;
    acc.push({ kind: fourcc(buf, offset + 4), offset, header, size, payload: offset + header, end: offset + size });
    const kind = fourcc(buf, offset + 4);
    if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(kind)) {
      walk(buf, offset + header, offset + size, acc);
    }
    offset += size;
  }
  return acc;
}

function wrap(kind, payload) {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + payload.length, 0);
  hdr.write(kind, 4, 4, "latin1");
  return Buffer.concat([hdr, payload]);
}

function table(buf, box) {
  return { version: buf[box.payload], count: be32(buf, box.payload + 4), data: buf.subarray(box.payload, box.end) };
}

function find(boxes, kind) {
  return boxes.find((b) => b.kind === kind);
}

function extractTracks(buf) {
  const boxes = walk(buf, 0, buf.length);
  const tracks = [];
  let current = null;
  for (const box of boxes) {
    if (box.kind === "trak") {
      current = { boxes: [] };
      tracks.push(current);
    }
    if (current) current.boxes.push(box);
  }
  return tracks.map((track) => {
    const hdlr = find(track.boxes, "hdlr");
    const mdhd = find(track.boxes, "mdhd");
    const handler = fourcc(buf, hdlr.payload + 8);
    const md = table(buf, mdhd);
    const timescale = md.version === 1 ? be32(md.data, 20) : be32(md.data, 12);
    const stts = table(buf, find(track.boxes, "stts"));
    const stsz = table(buf, find(track.boxes, "stsz"));
    const stsc = table(buf, find(track.boxes, "stsc"));
    const stcoBox = find(track.boxes, "stco") || find(track.boxes, "co64");
    const wide = stcoBox.kind === "co64";
    const stco = table(buf, stcoBox);
    const sizes = [];
    const constSize = be32(stsz.data, 4);
    const n = be32(stsz.data, 8);
    for (let i = 0; i < n; i++) sizes.push(constSize || be32(stsz.data, 12 + i * 4));
    const chunkOff = [];
    for (let i = 0; i < stco.count; i++) {
      chunkOff.push(wide ? Number(stco.data.readBigUInt64BE(8 + i * 8)) : be32(stco.data, 8 + i * 4));
    }
    const sc = [];
    for (let i = 0; i < stsc.count; i++) {
      sc.push({ first: be32(stsc.data, 8 + i * 12), spc: be32(stsc.data, 12 + i * 12) });
    }
    const spcAt = (chunkIdx) => {
      let v = sc[0].spc;
      for (const e of sc) if (chunkIdx + 1 >= e.first) v = e.spc;
      return v;
    };
    const dts = [];
    let clock = 0;
    for (let i = 0; i < stts.count; i++) {
      const c = be32(stts.data, 8 + i * 8);
      const d = be32(stts.data, 12 + i * 8);
      for (let k = 0; k < c; k++) {
        dts.push(clock);
        clock += d;
      }
    }
    const samples = [];
    let sample = 0;
    for (let ci = 0; ci < chunkOff.length; ci++) {
      let off = chunkOff[ci];
      const count = spcAt(ci);
      for (let s = 0; s < count && sample < n; s++, sample++) {
        samples.push({
          dtsMedia: dts[sample],
          dtsCommon: Math.round(dts[sample] * (COMMON_HZ / timescale)),
          bytes: Buffer.from(buf.subarray(off, off + sizes[sample])),
        });
        off += sizes[sample];
      }
    }
    if (samples.length !== n) throw new Error(`${handler} sample reconstruct ${samples.length} != ${n}`);
    return { handler, timescale, samples };
  });
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeStsc(spcList) {
  const runs = [];
  for (let i = 0; i < spcList.length; i++) {
    if (i === 0 || spcList[i] !== spcList[i - 1]) {
      runs.push({ first: i + 1, spc: spcList[i], sdi: 1 });
    }
  }
  const box = Buffer.alloc(16 + runs.length * 12);
  box.writeUInt32BE(box.length, 0);
  box.write("stsc", 4, 4, "latin1");
  box.writeUInt32BE(0, 8);
  box.writeUInt32BE(runs.length, 12);
  for (let i = 0; i < runs.length; i++) {
    const pos = 16 + i * 12;
    box.writeUInt32BE(runs[i].first, pos);
    box.writeUInt32BE(runs[i].spc, pos + 4);
    box.writeUInt32BE(runs[i].sdi, pos + 8);
  }
  return box;
}

function makeStco(offsets) {
  const box = Buffer.alloc(16 + offsets.length * 4);
  box.writeUInt32BE(box.length, 0);
  box.write("stco", 4, 4, "latin1");
  box.writeUInt32BE(0, 8);
  box.writeUInt32BE(offsets.length, 12);
  for (let i = 0; i < offsets.length; i++) box.writeUInt32BE(offsets[i] >>> 0, 16 + i * 4);
  return box;
}

function rebuildNamed(raw, kind, replaceChild) {
  const kids = parseSiblings(raw, 8, raw.length);
  return wrap(kind, Buffer.concat(kids.map((k) => replaceChild(k) || k.raw)));
}

function trakHandler(trakRaw) {
  const boxes = walk(trakRaw, 0, trakRaw.length);
  const hdlr = boxes.find((b) => b.kind === "hdlr");
  return fourcc(trakRaw, hdlr.payload + 8);
}

function rebuildMoov(moovRaw, tables) {
  const moovKids = parseSiblings(moovRaw, 8, moovRaw.length);
  return wrap("moov", Buffer.concat(moovKids.map((child) => {
    if (child.kind !== "trak") return child.raw;
    const handler = trakHandler(child.raw);
    const next = tables[handler];
    if (!next) return child.raw;
    return rebuildNamed(child.raw, "trak", (mdia) => {
      if (mdia.kind !== "mdia") return null;
      return rebuildNamed(mdia.raw, "mdia", (minf) => {
        if (minf.kind !== "minf") return null;
        return rebuildNamed(minf.raw, "minf", (stbl) => {
          if (stbl.kind !== "stbl") return null;
          return rebuildNamed(stbl.raw, "stbl", (box) => {
            if (box.kind === "stsc") return next.stsc;
            if (box.kind === "stco" || box.kind === "co64") return next.stco;
            return null;
          });
        });
      });
    });
  })));
}

function interleave(video, audio) {
  let vi = 0;
  let ai = 0;
  const chunks = [];
  while (vi < video.length || ai < audio.length) {
    const vDts = vi < video.length ? video[vi].dtsCommon : Number.POSITIVE_INFINITY;
    const aDts = ai < audio.length ? audio[ai].dtsCommon : Number.POSITIVE_INFINITY;
    if (vDts <= aDts) {
      const samples = [];
      while (
        vi < video.length
        && video[vi].dtsCommon <= aDts
        && samples.length < MAX_VIDEO_PER_CHUNK
      ) {
        samples.push(video[vi++]);
      }
      if (!samples.length) throw new Error("empty video chunk");
      chunks.push({ track: "vide", samples });
    } else {
      chunks.push({ track: "soun", samples: [audio[ai++]] });
    }
  }
  return chunks;
}

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error("usage: node mp4-fine-interleave.mjs <src.mp4> <dest.mp4>");
  process.exit(2);
}

const srcBuf = fs.readFileSync(src);
const top = parseSiblings(srcBuf, 0, srcBuf.length);
const moov = top.find((b) => b.kind === "moov");
const mdat = top.find((b) => b.kind === "mdat");
if (!moov || !mdat) throw new Error("need moov + mdat");

const tracks = extractTracks(srcBuf);
const video = tracks.find((t) => t.handler === "vide");
const audio = tracks.find((t) => t.handler === "soun");
if (!video || !audio) throw new Error("need vide + soun");

const srcVideoHash = sha(Buffer.concat(video.samples.map((s) => s.bytes)));
const srcAudioHash = sha(Buffer.concat(audio.samples.map((s) => s.bytes)));

const layout = interleave(video.samples, audio.samples);
const payloadParts = [];
const trackChunks = { vide: [], soun: [] };
let payloadOff = 0;
for (const chunk of layout) {
  trackChunks[chunk.track].push({ payloadOff, spc: chunk.samples.length });
  for (const sample of chunk.samples) {
    payloadParts.push(sample.bytes);
    payloadOff += sample.bytes.length;
  }
}
const payload = Buffer.concat(payloadParts);
if (payload.length !== video.samples.reduce((n, s) => n + s.bytes.length, 0) + audio.samples.reduce((n, s) => n + s.bytes.length, 0)) {
  throw new Error("payload size mismatch");
}

function tablesFor(handler, dummyBase) {
  const chunks = trackChunks[handler];
  return {
    stsc: makeStsc(chunks.map((c) => c.spc)),
    stco: makeStco(chunks.map((c) => dummyBase + c.payloadOff)),
  };
}

const dummy = rebuildMoov(moov.raw, {
  vide: tablesFor("vide", 0),
  soun: tablesFor("soun", 0),
});
const prefix = Buffer.concat(top.filter((b) => b.kind !== "moov" && b.kind !== "mdat").map((b) => b.raw));
const dataStart = prefix.length + dummy.length + 8;
const moovOut = rebuildMoov(moov.raw, {
  vide: tablesFor("vide", dataStart),
  soun: tablesFor("soun", dataStart),
});
if (moovOut.length !== dummy.length) throw new Error("moov size unstable");

const mdatOut = wrap("mdat", payload);
const out = Buffer.concat([prefix, moovOut, mdatOut]);

const outTracks = extractTracks(out);
const outVideo = outTracks.find((t) => t.handler === "vide");
const outAudio = outTracks.find((t) => t.handler === "soun");
const outVideoHash = sha(Buffer.concat(outVideo.samples.map((s) => s.bytes)));
const outAudioHash = sha(Buffer.concat(outAudio.samples.map((s) => s.bytes)));
if (outVideoHash !== srcVideoHash) throw new Error("video sample payload changed");
if (outAudioHash !== srcAudioHash) throw new Error("audio sample payload changed");
if (outVideo.samples.length !== video.samples.length) throw new Error("video sample count changed");
if (outAudio.samples.length !== audio.samples.length) throw new Error("audio sample count changed");

fs.writeFileSync(dest, out);
const fd = fs.openSync(dest, "r+");
fs.fsyncSync(fd);
fs.closeSync(fd);

const vSpc = trackChunks.vide.map((c) => c.spc);
const aSpc = trackChunks.soun.map((c) => c.spc);
console.log(JSON.stringify({
  src,
  dest,
  bytes: out.length,
  video_samples: video.samples.length,
  audio_samples: audio.samples.length,
  video_chunks: trackChunks.vide.length,
  audio_chunks: trackChunks.soun.length,
  video_spc_min: Math.min(...vSpc),
  video_spc_max: Math.max(...vSpc),
  audio_spc_max: Math.max(...aSpc),
  video_payload_sha256: outVideoHash,
  audio_payload_sha256: outAudioHash,
}, null, 2));
