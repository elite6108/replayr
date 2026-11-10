import fs from "node:fs";

function be32(b, o) { return b.readUInt32BE(o); }
function fourcc(b, o) {
  return [...b.subarray(o, o + 4)].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
}

function walk(buf, start, end, acc = []) {
  let o = start;
  while (o + 8 <= end) {
    let size = be32(buf, o);
    const kind = fourcc(buf, o + 4);
    let header = 8;
    if (size === 1) { header = 16; size = Number(buf.readBigUInt64BE(o + 8)); }
    if (size === 0) size = end - o;
    acc.push({ kind, offset: o, header, size, payload: o + header, end: o + size });
    if (["moov","trak","mdia","minf","stbl","edts"].includes(kind)) walk(buf, o + header, o + size, acc);
    o += size;
  }
  return acc;
}

function table(buf, box) {
  const p = buf.subarray(box.payload, box.end);
  return { version: p[0], count: be32(p, 4), data: p };
}

function reconstruct(file) {
  const buf = fs.readFileSync(file);
  const boxes = walk(buf, 0, buf.length);
  const tracks = [];
  let cur = null;
  for (const b of boxes) {
    if (b.kind === "trak") { cur = { boxes: [] }; tracks.push(cur); }
    if (cur) cur.boxes.push(b);
  }
  return tracks.map((t) => {
    const hdlr = t.boxes.find((b) => b.kind === "hdlr");
    const handler = hdlr ? fourcc(buf, hdlr.payload + 8) : "?";
    const mdhd = t.boxes.find((b) => b.kind === "mdhd");
    const md = table(buf, mdhd);
    const timescale = md.version === 1 ? be32(md.data, 20) : be32(md.data, 12);
    const stts = table(buf, t.boxes.find((b) => b.kind === "stts"));
    const stsz = table(buf, t.boxes.find((b) => b.kind === "stsz"));
    const stsc = table(buf, t.boxes.find((b) => b.kind === "stsc"));
    const stcoBox = t.boxes.find((b) => b.kind === "stco") || t.boxes.find((b) => b.kind === "co64");
    const wide = stcoBox.kind === "co64";
    const stco = table(buf, stcoBox);
    const stssBox = t.boxes.find((b) => b.kind === "stss");
    const keys = new Set();
    if (stssBox) {
      const tb = table(buf, stssBox);
      for (let i = 0; i < tb.count; i++) keys.add(be32(tb.data, 8 + i * 4));
    }
    const sizes = [];
    const constSize = be32(stsz.data, 4);
    const n = be32(stsz.data, 8);
    for (let i = 0; i < n; i++) sizes.push(constSize || be32(stsz.data, 12 + i * 4));
    const chunks = [];
    for (let i = 0; i < stco.count; i++) chunks.push(wide ? Number(stco.data.readBigUInt64BE(8 + i * 8)) : be32(stco.data, 8 + i * 4));
    const sc = [];
    for (let i = 0; i < stsc.count; i++) {
      sc.push({ first: be32(stsc.data, 8 + i * 12), spc: be32(stsc.data, 12 + i * 12) });
    }
    function spc(chunkIdx) {
      let v = sc[0].spc;
      for (const e of sc) if (chunkIdx + 1 >= e.first) v = e.spc;
      return v;
    }
    const dts = [];
    let clock = 0;
    for (let i = 0; i < stts.count; i++) {
      const c = be32(stts.data, 8 + i * 8);
      const d = be32(stts.data, 12 + i * 8);
      for (let k = 0; k < c; k++) { dts.push({ dts: clock, dur: d }); clock += d; }
    }
    const packets = [];
    let sample = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      let off = chunks[ci];
      const count = spc(ci);
      for (let s = 0; s < count && sample < n; s++, sample++) {
        packets.push({
          n: sample + 1,
          pts: dts[sample].dts,
          dts: dts[sample].dts,
          duration: dts[sample].dur,
          size: sizes[sample],
          offset: off,
          flags: keys.has(sample + 1) ? "K" : "_",
        });
        off += sizes[sample];
      }
    }
    return { handler, timescale, packets };
  });
}

function printTrack(label, tr) {
  const p = tr.packets;
  const ts = (x) => `${x} (${(x / tr.timescale).toFixed(4)}s)`;
  console.log(`\n${label} ${tr.handler} packets=${p.length} timescale=${tr.timescale}`);
  console.log("first 20:");
  for (const pkt of p.slice(0, 20)) {
    console.log(`  #${pkt.n} pts=${ts(pkt.pts)} dts=${ts(pkt.dts)} dur=${pkt.duration} flags=${pkt.flags} size=${pkt.size}`);
  }
  console.log("last 20:");
  for (const pkt of p.slice(-20)) {
    console.log(`  #${pkt.n} pts=${ts(pkt.pts)} dts=${ts(pkt.dts)} dur=${pkt.duration} flags=${pkt.flags} size=${pkt.size}`);
  }
}

for (const file of process.argv.slice(2)) {
  console.log("=".repeat(80));
  console.log(file);
  const tracks = reconstruct(file);
  for (const tr of tracks) printTrack(file.split("\\").pop(), tr);
  const v = tracks.find((t) => t.handler === "vide");
  const a = tracks.find((t) => t.handler === "soun");
  if (v && a) {
    const v0 = v.packets[0].pts / v.timescale;
    const a0 = a.packets[0].pts / a.timescale;
    const vN = (v.packets.at(-1).pts + v.packets.at(-1).duration) / v.timescale;
    const aN = (a.packets.at(-1).pts + a.packets.at(-1).duration) / a.timescale;
    console.log(`\ninterleave: video ${v0.toFixed(4)}..${vN.toFixed(4)}s audio ${a0.toFixed(4)}..${aN.toFixed(4)}s lead=${((vN - aN) * 1000).toFixed(1)}ms`);
    const keys = v.packets.filter((p) => p.flags === "K");
    const gaps = keys.slice(1).map((k, i) => (k.pts - keys[i].pts) / v.timescale);
    const avgGop = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
    console.log(`keyframes=${keys.length} avg_gop_s=${avgGop.toFixed(3)} first_keys=${keys.slice(0, 8).map((k) => k.n).join(",")}`);
  }
}
