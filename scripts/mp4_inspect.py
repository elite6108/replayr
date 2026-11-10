#!/usr/bin/env python3
"""Dump ISO-BMFF box trees and sample-table fields for A/B comparison."""

from __future__ import annotations

import json
import os
import struct
import sys
from pathlib import Path


CONTAINERS = {
    b"moov",
    b"trak",
    b"edts",
    b"mdia",
    b"minf",
    b"dinf",
    b"stbl",
    b"mvex",
    b"udta",
    b"skip",
    b"moof",
    b"traf",
    b"mfra",
}
FULLBOX_CONTAINERS = {b"meta"}
SAMPLE_DESC_CONTAINERS = {b"stsd"}
CODEC_CONTAINERS = {b"avc1", b"encv", b"hev1", b"hvc1", b"mp4a", b"enca", b"mp4v"}


def be_u16(data: bytes, off: int) -> int:
    return struct.unpack_from(">H", data, off)[0]


def be_u32(data: bytes, off: int) -> int:
    return struct.unpack_from(">I", data, off)[0]


def be_u64(data: bytes, off: int) -> int:
    return struct.unpack_from(">Q", data, off)[0]


def be_i16(data: bytes, off: int) -> int:
    return struct.unpack_from(">h", data, off)[0]


def be_i32(data: bytes, off: int) -> int:
    return struct.unpack_from(">i", data, off)[0]


def fourcc(data: bytes) -> str:
    return "".join(chr(b) if 32 <= b < 127 else "." for b in data)


def parse_header(fh, file_end: int, offset: int) -> tuple[int, int, bytes]:
    fh.seek(offset)
    head = fh.read(8)
    if len(head) < 8:
        raise ValueError(f"truncated box header at {offset}")
    size32 = be_u32(head, 0)
    kind = head[4:8]
    if size32 == 0:
        return 8, file_end - offset, kind
    if size32 == 1:
        wide = fh.read(8)
        size = be_u64(wide, 0)
        return 16, size, kind
    return 8, size32, kind


def walk_file(path: Path) -> list[dict]:
    size = path.stat().st_size
    boxes: list[dict] = []
    with path.open("rb") as fh:
        offset = 0
        while offset + 8 <= size:
            header_len, box_size, kind = parse_header(fh, size, offset)
            payload_off = offset + header_len
            payload_len = box_size - header_len
            node = describe_box(fh, offset, header_len, box_size, kind, payload_off, payload_len)
            boxes.append(node)
            offset += box_size
    return boxes


def describe_box(fh, offset, header_len, box_size, kind, payload_off, payload_len) -> dict:
    node = {
        "kind": fourcc(kind),
        "offset": offset,
        "size": box_size,
        "header": header_len,
    }
    fh.seek(payload_off)
    payload = fh.read(payload_len)
    if kind in CONTAINERS:
        node["children"] = walk_payload(payload, payload_off)
    elif kind in FULLBOX_CONTAINERS:
        node["version"] = payload[0] if payload else None
        node["children"] = walk_payload(payload[4:], payload_off + 4) if len(payload) >= 4 else []
    elif kind == b"ftyp":
        node.update(parse_ftyp(payload))
    elif kind == b"mvhd":
        node.update(parse_mvhd(payload))
    elif kind == b"tkhd":
        node.update(parse_tkhd(payload))
    elif kind == b"mdhd":
        node.update(parse_mdhd(payload))
    elif kind == b"hdlr":
        node.update(parse_hdlr(payload))
    elif kind == b"vmhd":
        node["present"] = True
    elif kind == b"smhd":
        node["present"] = True
    elif kind == b"elst":
        node.update(parse_elst(payload))
    elif kind == b"stsd":
        node.update(parse_stsd(payload, payload_off))
    elif kind == b"stts":
        node.update(parse_time_to_sample(payload, signed=False))
    elif kind == b"ctts":
        node.update(parse_time_to_sample(payload, signed=True))
    elif kind == b"stss":
        node.update(parse_stss(payload))
    elif kind == b"stsc":
        node.update(parse_stsc(payload))
    elif kind == b"stsz":
        node.update(parse_stsz(payload))
    elif kind == b"stz2":
        node["kind_note"] = "compact sample size"
        node["payload_len"] = len(payload)
    elif kind == b"stco":
        node.update(parse_stco(payload, wide=False))
    elif kind == b"co64":
        node.update(parse_stco(payload, wide=True))
    elif kind == b"sdtp":
        node["entry_bytes"] = max(0, len(payload) - 4)
    elif kind == b"uuid":
        node["uuid"] = payload[:16].hex() if len(payload) >= 16 else payload.hex()
        node["payload_len"] = len(payload)
    elif kind == b"free":
        node["payload_len"] = len(payload)
    elif kind == b"mdat":
        node["payload_len"] = len(payload)
        node["data_start"] = payload_off
        node["data_end"] = payload_off + payload_len
        node["head16"] = payload[:16].hex()
    else:
        node["payload_len"] = len(payload)
    return node


def walk_payload(payload: bytes, base: int) -> list[dict]:
    children = []
    offset = 0
    end = len(payload)
    while offset + 8 <= end:
        size32 = be_u32(payload, offset)
        kind = payload[offset + 4 : offset + 8]
        if size32 == 0:
            header_len, box_size = 8, end - offset
        elif size32 == 1:
            if offset + 16 > end:
                break
            header_len, box_size = 16, be_u64(payload, offset + 8)
        else:
            header_len, box_size = 8, size32
        if box_size < header_len or offset + box_size > end:
            children.append(
                {
                    "kind": fourcc(kind),
                    "offset": base + offset,
                    "size": box_size,
                    "error": "invalid nested size",
                }
            )
            break
        # Recurse by describing from a BytesIO-like slice via a temp file-like
        child_payload = payload[offset + header_len : offset + box_size]
        child = describe_from_bytes(kind, base + offset, header_len, box_size, child_payload, base + offset + header_len)
        children.append(child)
        offset += box_size
    return children


class _Cursor:
    def __init__(self, data: bytes, start: int):
        self.data = data
        self.start = start

    def seek(self, pos):
        self.pos = pos - self.start

    def read(self, n):
        chunk = self.data[self.pos : self.pos + n]
        self.pos += n
        return chunk


def describe_from_bytes(kind, offset, header_len, box_size, payload, payload_off) -> dict:
    node = {
        "kind": fourcc(kind),
        "offset": offset,
        "size": box_size,
        "header": header_len,
    }
    if kind in CONTAINERS:
        node["children"] = walk_payload(payload, payload_off)
    elif kind in FULLBOX_CONTAINERS:
        node["version"] = payload[0] if payload else None
        node["children"] = walk_payload(payload[4:], payload_off + 4) if len(payload) >= 4 else []
    elif kind == b"mvhd":
        node.update(parse_mvhd(payload))
    elif kind == b"tkhd":
        node.update(parse_tkhd(payload))
    elif kind == b"mdhd":
        node.update(parse_mdhd(payload))
    elif kind == b"hdlr":
        node.update(parse_hdlr(payload))
    elif kind == b"elst":
        node.update(parse_elst(payload))
    elif kind == b"stsd":
        node.update(parse_stsd(payload, payload_off))
    elif kind == b"stts":
        node.update(parse_time_to_sample(payload, signed=False))
    elif kind == b"ctts":
        node.update(parse_time_to_sample(payload, signed=True))
    elif kind == b"stss":
        node.update(parse_stss(payload))
    elif kind == b"stsc":
        node.update(parse_stsc(payload))
    elif kind == b"stsz":
        node.update(parse_stsz(payload))
    elif kind == b"stco":
        node.update(parse_stco(payload, wide=False))
    elif kind == b"co64":
        node.update(parse_stco(payload, wide=True))
    elif kind in CODEC_CONTAINERS:
        node.update(parse_sample_entry(kind, payload, payload_off))
    elif kind == b"avcC":
        node.update(parse_avcc(payload))
    elif kind == b"esds":
        node.update(parse_esds(payload))
    elif kind == b"btrt":
        if len(payload) >= 12:
            node["bufferSizeDB"] = be_u32(payload, 0)
            node["maxBitrate"] = be_u32(payload, 4)
            node["avgBitrate"] = be_u32(payload, 8)
    elif kind == b"pasp":
        if len(payload) >= 8:
            node["hSpacing"] = be_u32(payload, 0)
            node["vSpacing"] = be_u32(payload, 4)
    elif kind == b"colr":
        node["type"] = fourcc(payload[:4]) if len(payload) >= 4 else None
        node["payload_hex"] = payload.hex()
    else:
        node["payload_len"] = len(payload)
        if len(payload) <= 64:
            node["payload_hex"] = payload.hex()
    return node


def parse_ftyp(payload: bytes) -> dict:
    major = fourcc(payload[0:4]) if len(payload) >= 4 else ""
    minor = be_u32(payload, 4) if len(payload) >= 8 else 0
    brands = [fourcc(payload[i : i + 4]) for i in range(8, len(payload), 4) if i + 4 <= len(payload)]
    return {"major_brand": major, "minor_version": minor, "compatible_brands": brands}


def parse_mvhd(payload: bytes) -> dict:
    version = payload[0]
    if version == 1:
        timescale = be_u32(payload, 20)
        duration = be_u64(payload, 24)
        rate_off = 32
    else:
        timescale = be_u32(payload, 12)
        duration = be_u32(payload, 16)
        rate_off = 20
    rate = be_u32(payload, rate_off) / 65536 if len(payload) >= rate_off + 4 else None
    return {
        "version": version,
        "timescale": timescale,
        "duration": duration,
        "duration_sec": duration / timescale if timescale else None,
        "rate": rate,
        "next_track_id": be_u32(payload, len(payload) - 4) if len(payload) >= 4 else None,
    }


def parse_tkhd(payload: bytes) -> dict:
    version = payload[0]
    flags = int.from_bytes(payload[1:4], "big")
    if version == 1:
        track_id = be_u32(payload, 20)
        duration = be_u64(payload, 28)
        rest = 36
    else:
        track_id = be_u32(payload, 12)
        duration = be_u32(payload, 20)
        rest = 24
    width = be_u32(payload, len(payload) - 8) / 65536 if len(payload) >= 8 else None
    height = be_u32(payload, len(payload) - 4) / 65536 if len(payload) >= 4 else None
    return {
        "version": version,
        "flags": flags,
        "enabled": bool(flags & 1),
        "in_movie": bool(flags & 2),
        "track_id": track_id,
        "duration": duration,
        "width": width,
        "height": height,
    }


def parse_mdhd(payload: bytes) -> dict:
    version = payload[0]
    if version == 1:
        timescale = be_u32(payload, 20)
        duration = be_u64(payload, 24)
        lang_off = 32
    else:
        timescale = be_u32(payload, 12)
        duration = be_u32(payload, 16)
        lang_off = 20
    return {
        "version": version,
        "timescale": timescale,
        "duration": duration,
        "duration_sec": duration / timescale if timescale else None,
        "language_packed": be_u16(payload, lang_off) if len(payload) >= lang_off + 2 else None,
    }


def parse_hdlr(payload: bytes) -> dict:
    handler = fourcc(payload[8:12]) if len(payload) >= 12 else ""
    name = payload[24:].split(b"\x00", 1)[0].decode("utf-8", "replace") if len(payload) > 24 else ""
    return {"handler": handler, "name": name}


def parse_elst(payload: bytes) -> dict:
    version = payload[0]
    count = be_u32(payload, 4)
    entries = []
    pos = 8
    for _ in range(count):
        if version == 1:
            segment = be_u64(payload, pos)
            media = struct.unpack_from(">q", payload, pos + 8)[0]
            rate = be_u32(payload, pos + 16)
            pos += 20
        else:
            segment = be_u32(payload, pos)
            media = be_i32(payload, pos + 4)
            rate = be_u32(payload, pos + 8)
            pos += 12
        entries.append(
            {
                "segment_duration": segment,
                "media_time": media,
                "media_rate": rate / 65536,
            }
        )
    return {"version": version, "entry_count": count, "entries": entries}


def parse_time_to_sample(payload: bytes, signed: bool) -> dict:
    version = payload[0]
    count = be_u32(payload, 4)
    entries = []
    pos = 8
    total = 0
    for _ in range(min(count, 12)):
        sample_count = be_u32(payload, pos)
        delta = be_i32(payload, pos + 4) if signed else be_u32(payload, pos + 4)
        entries.append({"count": sample_count, "delta": delta})
        total += sample_count
        pos += 8
    # finish remaining for totals
    samples = total
    for _ in range(max(0, count - 12)):
        samples += be_u32(payload, pos)
        pos += 8
    return {
        "version": version,
        "entry_count": count,
        "sample_count_sum": samples if count <= 12 else None,
        "first_entries": entries,
        "last_entry": _last_stts(payload, count, signed),
    }


def _last_stts(payload: bytes, count: int, signed: bool) -> dict | None:
    if count == 0:
        return None
    pos = 8 + (count - 1) * 8
    sample_count = be_u32(payload, pos)
    delta = be_i32(payload, pos + 4) if signed else be_u32(payload, pos + 4)
    return {"count": sample_count, "delta": delta}


def parse_stss(payload: bytes) -> dict:
    count = be_u32(payload, 4)
    first = [be_u32(payload, 8 + i * 4) for i in range(min(count, 8))]
    last = be_u32(payload, 8 + (count - 1) * 4) if count else None
    return {"entry_count": count, "first_sync_samples": first, "last_sync_sample": last}


def parse_stsc(payload: bytes) -> dict:
    count = be_u32(payload, 4)
    entries = []
    for i in range(min(count, 8)):
        pos = 8 + i * 12
        entries.append(
            {
                "first_chunk": be_u32(payload, pos),
                "samples_per_chunk": be_u32(payload, pos + 4),
                "sample_description_index": be_u32(payload, pos + 8),
            }
        )
    last = None
    if count:
        pos = 8 + (count - 1) * 12
        last = {
            "first_chunk": be_u32(payload, pos),
            "samples_per_chunk": be_u32(payload, pos + 4),
            "sample_description_index": be_u32(payload, pos + 8),
        }
    return {"entry_count": count, "first_entries": entries, "last_entry": last}


def parse_stsz(payload: bytes) -> dict:
    sample_size = be_u32(payload, 4)
    count = be_u32(payload, 8)
    sizes = []
    if sample_size == 0:
        sizes = [be_u32(payload, 12 + i * 4) for i in range(min(count, 8))]
        last = be_u32(payload, 12 + (count - 1) * 4) if count else None
        total = None
        if count <= 200000:
            total = sum(be_u32(payload, 12 + i * 4) for i in range(count))
    else:
        last = sample_size
        total = sample_size * count
    return {
        "constant_sample_size": sample_size,
        "sample_count": count,
        "first_sizes": sizes,
        "last_size": last,
        "payload_bytes_sum": total,
    }


def parse_stco(payload: bytes, wide: bool) -> dict:
    count = be_u32(payload, 4)
    width = 8 if wide else 4
    offs = []
    for i in range(min(count, 8)):
        pos = 8 + i * width
        offs.append(be_u64(payload, pos) if wide else be_u32(payload, pos))
    last = None
    if count:
        pos = 8 + (count - 1) * width
        last = be_u64(payload, pos) if wide else be_u32(payload, pos)
    return {
        "entry_count": count,
        "first_offsets": offs,
        "last_offset": last,
        "min_offset": min(offs) if offs else None,
        "table_bytes": 8 + count * width,
    }


def parse_stsd(payload: bytes, payload_off: int) -> dict:
    version = payload[0]
    count = be_u32(payload, 4)
    children = walk_payload(payload[8:], payload_off + 8)
    return {"version": version, "entry_count": count, "children": children}


def parse_sample_entry(kind: bytes, payload: bytes, payload_off: int) -> dict:
    node: dict = {"data_reference_index": be_u16(payload, 6) if len(payload) >= 8 else None}
    if kind in {b"avc1", b"encv", b"hev1", b"hvc1", b"mp4v"}:
        if len(payload) >= 78:
            node["width"] = be_u16(payload, 24)
            node["height"] = be_u16(payload, 26)
            node["horizresolution"] = be_u32(payload, 28)
            node["vertresolution"] = be_u32(payload, 32)
            node["frame_count"] = be_u16(payload, 40)
            node["depth"] = be_u16(payload, 74)
            compressor = payload[43:74].split(b"\x00", 1)[0]
            node["compressor"] = compressor.decode("utf-8", "replace")
        node["children"] = walk_payload(payload[78:], payload_off + 78) if len(payload) > 78 else []
    elif kind in {b"mp4a", b"enca"}:
        if len(payload) >= 28:
            node["channel_count"] = be_u16(payload, 16)
            node["sample_size"] = be_u16(payload, 18)
            node["sample_rate"] = be_u32(payload, 24) / 65536
        node["children"] = walk_payload(payload[28:], payload_off + 28) if len(payload) > 28 else []
    else:
        node["payload_len"] = len(payload)
    return node


def parse_avcc(payload: bytes) -> dict:
    if len(payload) < 7:
        return {"error": "short avcC", "hex": payload.hex()}
    nal_len = (payload[4] & 3) + 1
    sps_count = payload[5] & 0x1F
    pos = 6
    sps = []
    for _ in range(sps_count):
        if pos + 2 > len(payload):
            break
        n = be_u16(payload, pos)
        pos += 2
        sps.append(payload[pos : pos + n].hex())
        pos += n
    pps = []
    if pos < len(payload):
        pps_count = payload[pos]
        pos += 1
        for _ in range(pps_count):
            if pos + 2 > len(payload):
                break
            n = be_u16(payload, pos)
            pos += 2
            pps.append(payload[pos : pos + n].hex())
            pos += n
    return {
        "configurationVersion": payload[0],
        "AVCProfileIndication": payload[1],
        "profile_compatibility": payload[2],
        "AVCLevelIndication": payload[3],
        "lengthSizeMinusOne": nal_len - 1,
        "sps": sps,
        "pps": pps,
        "payload_len": len(payload),
    }


def parse_esds(payload: bytes) -> dict:
    return {"version": payload[0] if payload else None, "descriptor_hex": payload[4:80].hex(), "payload_len": len(payload)}


def flatten(boxes: list[dict], prefix: str = "") -> list[str]:
    lines = []
    for box in boxes:
        path = f"{prefix}/{box['kind']}"
        extra = []
        for key in (
            "major_brand",
            "compatible_brands",
            "timescale",
            "duration",
            "duration_sec",
            "track_id",
            "handler",
            "width",
            "height",
            "entry_count",
            "sample_count",
            "constant_sample_size",
            "version",
            "first_offsets",
            "last_offset",
            "channel_count",
            "sample_rate",
            "AVCProfileIndication",
            "AVCLevelIndication",
            "sps",
            "pps",
            "entries",
            "uuid",
        ):
            if key in box:
                extra.append(f"{key}={box[key]}")
        lines.append(f"{path} @ {box.get('offset')} size={box.get('size')} {' '.join(extra)}")
        if "children" in box:
            lines.extend(flatten(box["children"], path))
    return lines


def collect_stco(boxes: list[dict], acc: list[dict] | None = None, track: str | None = None) -> list[dict]:
    acc = acc or []
    for box in boxes:
        kind = box.get("kind")
        if kind == "trak":
            track = None
        if kind == "hdlr":
            track = box.get("handler")
        if kind in {"stco", "co64"}:
            acc.append({"track": track, "kind": kind, **{k: box[k] for k in box if k not in {"kind", "children"}}})
        if "children" in box:
            collect_stco(box["children"], acc, track)
    return acc


def mdat_range(boxes: list[dict]) -> tuple[int, int] | None:
    for box in boxes:
        if box.get("kind") == "mdat":
            start = box.get("data_start") or (box["offset"] + box.get("header", 8))
            return start, start + box.get("payload_len", box["size"] - box.get("header", 8))
    return None


def summarize(path: Path, boxes: list[dict]) -> dict:
    order = [b["kind"] for b in boxes]
    mdat = mdat_range(boxes)
    stcos = collect_stco(boxes)
    offset_ok = []
    if mdat:
        lo, hi = mdat
        for table in stcos:
            offs = list(table.get("first_offsets") or [])
            if table.get("last_offset") is not None:
                offs.append(table["last_offset"])
            bad = [o for o in offs if o < lo or o >= hi]
            offset_ok.append(
                {
                    "track": table.get("track"),
                    "kind": table.get("kind"),
                    "count": table.get("entry_count"),
                    "first": table.get("first_offsets"),
                    "last": table.get("last_offset"),
                    "mdat": [lo, hi],
                    "outside_mdat": bad,
                }
            )
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "top_level": [
            {"kind": b["kind"], "offset": b["offset"], "size": b["size"], **({k: b[k] for k in ("major_brand", "compatible_brands", "uuid") if k in b})}
            for b in boxes
        ],
        "top_order": order,
        "moov_before_mdat": "moov" in order and "mdat" in order and order.index("moov") < order.index("mdat"),
        "chunk_offset_check": offset_ok,
        "tree": flatten(boxes),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: mp4_inspect.py <file.mp4> [file.mp4 ...]")
        return 2
    reports = []
    for arg in argv[1:]:
        path = Path(arg)
        boxes = walk_file(path)
        report = summarize(path, boxes)
        reports.append(report)
        print("=" * 80)
        print(path)
        print(f"bytes={report['bytes']} order={report['top_order']} moov_before_mdat={report['moov_before_mdat']}")
        for line in report["tree"]:
            print(line)
        print("-- chunk offsets --")
        print(json.dumps(report["chunk_offset_check"], indent=2))
    if len(reports) == 2:
        a, b = reports
        print("=" * 80)
        print("FIRST TREE LINE DIFF")
        sa, sb = a["tree"], b["tree"]
        n = max(len(sa), len(sb))
        shown = 0
        for i in range(n):
            la = sa[i] if i < len(sa) else "<missing>"
            lb = sb[i] if i < len(sb) else "<missing>"
            if la != lb:
                print(f"A: {la}")
                print(f"B: {lb}")
                shown += 1
                if shown >= 40:
                    print(f"... {n - i - 1} more lines")
                    break
        if shown == 0:
            print("no tree-line differences (values may still differ inside omitted tails)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
