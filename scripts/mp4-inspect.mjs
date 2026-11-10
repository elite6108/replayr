import fs from "node:fs";
import path from "node:path";

const CONTAINERS = new Set([
  "moov", "trak", "edts", "mdia", "minf", "dinf", "stbl", "mvex", "udta", "skip", "moof", "traf", "mfra",
]);
const CODEC = new Set(["avc1", "avc3", "encv", "hev1", "hvc1", "mp4a", "enca", "mp4v"]);

function be16(buf, o) { return buf.readUInt16BE(o); }
function be32(buf, o) { return buf.readUInt32BE(o); }
function be64(buf, o) { return Number(buf.readBigUInt64BE(o)); }
function bei32(buf, o) { return buf.readInt32BE(o); }
function fourcc(buf, o = 0) {
  return [...buf.subarray(o, o + 4)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
}

function readHeader(buf, offset, fileEnd) {
  const size32 = be32(buf, offset);
  const kind = fourcc(buf, offset + 4);
  if (size32 === 0) return { header: 8, size: fileEnd - offset, kind };
  if (size32 === 1) return { header: 16, size: be64(buf, offset + 8), kind };
  return { header: 8, size: size32, kind };
}

function walk(buf, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const { header, size, kind } = readHeader(buf, offset, end);
    if (size < header || offset + size > end) {
      boxes.push({ kind, offset, size, error: "invalid size" });
      break;
    }
    boxes.push(describe(buf, offset, header, size, kind));
    offset += size;
  }
  return boxes;
}

function describe(buf, offset, header, size, kind) {
  const payloadOff = offset + header;
  const payloadEnd = offset + size;
  const payload = buf.subarray(payloadOff, payloadEnd);
  const node = { kind, offset, size, header };
  if (CONTAINERS.has(kind)) node.children = walk(buf, payloadOff, payloadEnd);
  else if (kind === "meta") {
    node.version = payload[0];
    node.children = walk(buf, payloadOff + 4, payloadEnd);
  } else if (kind === "ftyp") Object.assign(node, parseFtyp(payload));
  else if (kind === "mvhd") Object.assign(node, parseMvhd(payload));
  else if (kind === "tkhd") Object.assign(node, parseTkhd(payload));
  else if (kind === "mdhd") Object.assign(node, parseMdhd(payload));
  else if (kind === "hdlr") Object.assign(node, parseHdlr(payload));
  else if (kind === "elst") Object.assign(node, parseElst(payload));
  else if (kind === "stsd") Object.assign(node, parseStsd(buf, payloadOff, payloadEnd));
  else if (kind === "stts") Object.assign(node, parseStts(payload, false));
  else if (kind === "ctts") Object.assign(node, parseStts(payload, true));
  else if (kind === "stss") Object.assign(node, parseStss(payload));
  else if (kind === "stsc") Object.assign(node, parseStsc(payload));
  else if (kind === "stsz") Object.assign(node, parseStsz(payload));
  else if (kind === "stco") Object.assign(node, parseStco(payload, false));
  else if (kind === "co64") Object.assign(node, parseStco(payload, true));
  else if (CODEC.has(kind)) Object.assign(node, parseSampleEntry(kind, buf, payloadOff, payloadEnd));
  else if (kind === "avcC") Object.assign(node, parseAvcc(payload));
  else if (kind === "esds") Object.assign(node, { version: payload[0], payload_len: payload.length, descriptor_hex: payload.subarray(4, 80).toString("hex") });
  else if (kind === "btrt" && payload.length >= 12) {
    node.bufferSizeDB = be32(payload, 0);
    node.maxBitrate = be32(payload, 4);
    node.avgBitrate = be32(payload, 8);
  } else if (kind === "pasp" && payload.length >= 8) {
    node.hSpacing = be32(payload, 0);
    node.vSpacing = be32(payload, 4);
  } else if (kind === "colr") {
    node.type = fourcc(payload, 0);
    node.payload_hex = payload.toString("hex");
  } else if (kind === "uuid") {
    node.uuid = payload.subarray(0, 16).toString("hex");
    node.payload_len = payload.length;
  } else if (kind === "mdat") {
    node.payload_len = payload.length;
    node.data_start = payloadOff;
    node.data_end = payloadEnd;
    node.head16 = payload.subarray(0, 16).toString("hex");
  } else {
    node.payload_len = payload.length;
    if (payload.length <= 48) node.payload_hex = payload.toString("hex");
  }
  return node;
}

function parseFtyp(p) {
  const brands = [];
  for (let i = 8; i + 4 <= p.length; i += 4) brands.push(fourcc(p, i));
  return { major_brand: fourcc(p, 0), minor_version: be32(p, 4), compatible_brands: brands };
}

function parseMvhd(p) {
  const version = p[0];
  const timescale = version === 1 ? be32(p, 20) : be32(p, 12);
  const duration = version === 1 ? be64(p, 24) : be32(p, 16);
  return { version, timescale, duration, duration_sec: timescale ? duration / timescale : null, next_track_id: be32(p, p.length - 4) };
}

function parseTkhd(p) {
  const version = p[0];
  const flags = (p[1] << 16) | (p[2] << 8) | p[3];
  const track_id = version === 1 ? be32(p, 20) : be32(p, 12);
  const duration = version === 1 ? be64(p, 28) : be32(p, 20);
  return {
    version, flags, enabled: Boolean(flags & 1), in_movie: Boolean(flags & 2), track_id, duration,
    width: be32(p, p.length - 8) / 65536, height: be32(p, p.length - 4) / 65536,
  };
}

function parseMdhd(p) {
  const version = p[0];
  const timescale = version === 1 ? be32(p, 20) : be32(p, 12);
  const duration = version === 1 ? be64(p, 24) : be32(p, 16);
  return { version, timescale, duration, duration_sec: timescale ? duration / timescale : null };
}

function parseHdlr(p) {
  const nameEnd = p.indexOf(0, 24);
  return { handler: fourcc(p, 8), name: p.subarray(24, nameEnd === -1 ? p.length : nameEnd).toString("utf8") };
}

function parseElst(p) {
  const version = p[0];
  const count = be32(p, 4);
  const entries = [];
  let pos = 8;
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      entries.push({ segment_duration: be64(p, pos), media_time: Number(p.readBigInt64BE(pos + 8)), media_rate: be32(p, pos + 16) / 65536 });
      pos += 20;
    } else {
      entries.push({ segment_duration: be32(p, pos), media_time: bei32(p, pos + 4), media_rate: be32(p, pos + 8) / 65536 });
      pos += 12;
    }
  }
  return { version, entry_count: count, entries };
}

function parseStts(p, signed) {
  const version = p[0];
  const count = be32(p, 4);
  const first = [];
  let samples = 0;
  for (let i = 0; i < count; i++) {
    const c = be32(p, 8 + i * 8);
    const d = signed ? bei32(p, 12 + i * 8) : be32(p, 12 + i * 8);
    samples += c;
    if (i < 8) first.push({ count: c, delta: d });
  }
  const last = count ? { count: be32(p, 8 + (count - 1) * 8), delta: signed ? bei32(p, 12 + (count - 1) * 8) : be32(p, 12 + (count - 1) * 8) } : null;
  return { version, entry_count: count, sample_count_sum: samples, first_entries: first, last_entry: last };
}

function parseStss(p) {
  const count = be32(p, 4);
  const first = [];
  for (let i = 0; i < Math.min(count, 8); i++) first.push(be32(p, 8 + i * 4));
  return { entry_count: count, first_sync_samples: first, last_sync_sample: count ? be32(p, 8 + (count - 1) * 4) : null };
}

function parseStsc(p) {
  const count = be32(p, 4);
  const first = [];
  for (let i = 0; i < Math.min(count, 8); i++) {
    const pos = 8 + i * 12;
    first.push({ first_chunk: be32(p, pos), samples_per_chunk: be32(p, pos + 4), sample_description_index: be32(p, pos + 8) });
  }
  const last = count ? {
    first_chunk: be32(p, 8 + (count - 1) * 12),
    samples_per_chunk: be32(p, 8 + (count - 1) * 12 + 4),
    sample_description_index: be32(p, 8 + (count - 1) * 12 + 8),
  } : null;
  return { entry_count: count, first_entries: first, last_entry: last };
}

function parseStsz(p) {
  const sample_size = be32(p, 4);
  const count = be32(p, 8);
  const first = [];
  let sum = 0;
  if (sample_size === 0) {
    for (let i = 0; i < count; i++) {
      const sz = be32(p, 12 + i * 4);
      sum += sz;
      if (i < 8) first.push(sz);
    }
  } else sum = sample_size * count;
  return {
    constant_sample_size: sample_size,
    sample_count: count,
    first_sizes: first,
    last_size: sample_size || (count ? be32(p, 12 + (count - 1) * 4) : null),
    payload_bytes_sum: sum,
  };
}

function parseStco(p, wide) {
  const count = be32(p, 4);
  const w = wide ? 8 : 4;
  const first = [];
  for (let i = 0; i < Math.min(count, 8); i++) first.push(wide ? be64(p, 8 + i * w) : be32(p, 8 + i * w));
  const last = count ? (wide ? be64(p, 8 + (count - 1) * w) : be32(p, 8 + (count - 1) * w)) : null;
  let min = first[0];
  let max = first[0];
  for (let i = 0; i < count; i++) {
    const v = wide ? be64(p, 8 + i * w) : be32(p, 8 + i * w);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { entry_count: count, first_offsets: first, last_offset: last, min_offset: min ?? null, max_offset: max ?? null };
}

function parseStsd(buf, payloadOff, payloadEnd) {
  const version = buf[payloadOff];
  const count = be32(buf, payloadOff + 4);
  return { version, entry_count: count, children: walk(buf, payloadOff + 8, payloadEnd) };
}

function parseSampleEntry(kind, buf, payloadOff, payloadEnd) {
  const p = buf.subarray(payloadOff, payloadEnd);
  const node = { data_reference_index: p.length >= 8 ? be16(p, 6) : null };
  if (["avc1", "avc3", "encv", "hev1", "hvc1", "mp4v"].includes(kind)) {
    if (p.length >= 78) {
      node.width = be16(p, 24);
      node.height = be16(p, 26);
      node.horizresolution = be32(p, 28);
      node.vertresolution = be32(p, 32);
      node.frame_count = be16(p, 40);
      node.depth = be16(p, 74);
      node.compressor = p.subarray(43, 74).toString("utf8").replace(/\0+$/, "");
    }
    node.children = walk(buf, payloadOff + 78, payloadEnd);
  } else if (kind === "mp4a" || kind === "enca") {
    if (p.length >= 28) {
      node.channel_count = be16(p, 16);
      node.sample_size = be16(p, 18);
      node.sample_rate = be32(p, 24) / 65536;
    }
    node.children = walk(buf, payloadOff + 28, payloadEnd);
  }
  return node;
}

function parseAvcc(p) {
  if (p.length < 7) return { error: "short avcC", hex: p.toString("hex") };
  const nalLen = (p[4] & 3) + 1;
  const spsCount = p[5] & 0x1f;
  let pos = 6;
  const sps = [];
  for (let i = 0; i < spsCount; i++) {
    const n = be16(p, pos); pos += 2;
    sps.push(p.subarray(pos, pos + n).toString("hex"));
    pos += n;
  }
  const pps = [];
  if (pos < p.length) {
    const ppsCount = p[pos++];
    for (let i = 0; i < ppsCount; i++) {
      const n = be16(p, pos); pos += 2;
      pps.push(p.subarray(pos, pos + n).toString("hex"));
      pos += n;
    }
  }
  return {
    configurationVersion: p[0],
    AVCProfileIndication: p[1],
    profile_compatibility: p[2],
    AVCLevelIndication: p[3],
    lengthSizeMinusOne: nalLen - 1,
    sps, pps, payload_len: p.length,
  };
}

function flatten(boxes, prefix = "") {
  const lines = [];
  for (const box of boxes) {
    const pth = `${prefix}/${box.kind}`;
    const extra = [];
    for (const key of [
      "major_brand", "compatible_brands", "timescale", "duration", "duration_sec", "track_id",
      "handler", "width", "height", "entry_count", "sample_count", "constant_sample_size",
      "version", "first_offsets", "last_offset", "min_offset", "max_offset", "channel_count",
      "sample_rate", "AVCProfileIndication", "AVCLevelIndication", "sps", "pps", "entries",
      "uuid", "enabled", "in_movie", "sample_count_sum", "first_entries", "last_entry",
      "avgBitrate", "maxBitrate", "compressor", "payload_bytes_sum",
    ]) {
      if (box[key] !== undefined) extra.push(`${key}=${JSON.stringify(box[key])}`);
    }
    lines.push(`${pth} @ ${box.offset} size=${box.size}${extra.length ? " " + extra.join(" ") : ""}`);
    if (box.children) lines.push(...flatten(box.children, pth));
  }
  return lines;
}

function collect(boxes, pred, acc = [], track = null) {
  for (const box of boxes) {
    let next = track;
    if (box.kind === "trak") next = null;
    if (box.kind === "hdlr") next = box.handler;
    if (pred(box)) acc.push({ track: next, ...box });
    if (box.children) collect(box.children, pred, acc, next);
  }
  return acc;
}

function summarize(filePath, boxes) {
  const order = boxes.map((b) => b.kind);
  const mdat = boxes.find((b) => b.kind === "mdat");
  const lo = mdat?.data_start;
  const hi = mdat?.data_end;
  const tables = collect(boxes, (b) => b.kind === "stco" || b.kind === "co64");
  const chunk = tables.map((t) => {
    const outside = [];
    if (lo != null) {
      if (t.min_offset < lo || t.max_offset >= hi) outside.push({ min: t.min_offset, max: t.max_offset, mdat: [lo, hi] });
    }
    return {
      track: t.track, kind: t.kind, count: t.entry_count,
      first: t.first_offsets, last: t.last_offset, min: t.min_offset, max: t.max_offset,
      mdat: [lo, hi], outside_mdat: outside,
    };
  });
  return {
    path: filePath,
    bytes: fs.statSync(filePath).size,
    top_level: boxes.map((b) => ({
      kind: b.kind, offset: b.offset, size: b.size,
      ...(b.major_brand ? { major_brand: b.major_brand, compatible_brands: b.compatible_brands } : {}),
      ...(b.uuid ? { uuid: b.uuid } : {}),
    })),
    top_order: order,
    moov_before_mdat: order.includes("moov") && order.includes("mdat") && order.indexOf("moov") < order.indexOf("mdat"),
    chunk_offset_check: chunk,
    tree: flatten(boxes),
  };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node mp4-inspect.mjs <file.mp4> ...");
  process.exit(2);
}

const reports = files.map((file) => {
  const buf = fs.readFileSync(file);
  const boxes = walk(buf, 0, buf.length);
  const report = summarize(path.resolve(file), boxes);
  console.log("=".repeat(80));
  console.log(report.path);
  console.log(`bytes=${report.bytes} order=${report.top_order.join(",")} moov_before_mdat=${report.moov_before_mdat}`);
  for (const line of report.tree) console.log(line);
  console.log("-- chunk offsets --");
  console.log(JSON.stringify(report.chunk_offset_check, null, 2));
  return report;
});

if (reports.length >= 2) {
  console.log("=".repeat(80));
  console.log("FIRST TREE LINE DIFF");
  const [a, b] = reports;
  let shown = 0;
  const n = Math.max(a.tree.length, b.tree.length);
  for (let i = 0; i < n; i++) {
    const la = a.tree[i] ?? "<missing>";
    const lb = b.tree[i] ?? "<missing>";
    if (la !== lb) {
      console.log(`A: ${la}`);
      console.log(`B: ${lb}`);
      shown += 1;
      if (shown >= 60) {
        console.log(`... stopped after 60 diffs`);
        break;
      }
    }
  }
  if (!shown) console.log("no flattened tree-line differences");
}
