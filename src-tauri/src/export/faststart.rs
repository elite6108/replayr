//! Relocate `moov` before `mdat` so Safari / iOS can stream the file.
//!
//! This is a copy remux only: H.264/AAC sample bytes, timestamps, and
//! keyframes are not rewritten. Chunk offsets in `stco`/`co64` are adjusted
//! by the byte shift created when `moov` moves in front of `mdat`.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const COPY_CHUNK: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TopBox {
    offset: u64,
    #[allow(dead_code)]
    header_len: u64,
    size: u64,
    kind: [u8; 4],
}

impl TopBox {
    fn kind_is(self, name: &[u8; 4]) -> bool {
        &self.kind == name
    }

    fn end(self) -> u64 {
        self.offset.saturating_add(self.size)
    }
}

struct RemovePath(PathBuf);

impl Drop for RemovePath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Rewrite `path` so `moov` precedes `mdat`, replacing the file in place.
///
/// Already-faststarted files are left untouched. Temp output is fsynced, then
/// swapped over `path`; the temp is deleted on success or failure.
pub fn faststart_mp4_in_place(path: &Path) -> Result<bool, String> {
    let meta = std::fs::metadata(path).map_err(|err| {
        format!("Could not read {} for fast-start: {err}", path.display())
    })?;
    if meta.len() < 16 {
        return Err(format!("{} is too small to be an MP4.", path.display()));
    }
    let boxes = read_top_boxes(path)?;
    reject_unsupported(&boxes)?;
    let Some(moov) = boxes.iter().copied().find(|item| item.kind_is(b"moov")) else {
        return Err(format!("{} has no moov atom.", path.display()));
    };
    let Some(mdat) = boxes.iter().copied().find(|item| item.kind_is(b"mdat")) else {
        return Err(format!("{} has no mdat atom.", path.display()));
    };
    if moov.offset < mdat.offset {
        tracing::info!(
            path = %path.display(),
            "MP4 already has moov before mdat; skipping fast-start"
        );
        return Ok(false);
    }

    let tmp = temp_path(path);
    let cleanup = RemovePath(tmp.clone());
    rewrite_faststart(path, &tmp, &boxes, moov, mdat)?;
    fsync_path(&tmp)?;
    replace_file(&tmp, path)?;
    std::mem::forget(cleanup);
    let _ = std::fs::remove_file(&tmp);
    tracing::info!(
        path = %path.display(),
        moov_bytes = moov.size,
        "relocated moov before mdat for iOS streaming"
    );
    Ok(true)
}

pub(crate) fn moov_precedes_mdat(path: &Path) -> Result<bool, String> {
    let boxes = read_top_boxes(path)?;
    let moov = boxes.iter().find(|item| item.kind_is(b"moov"));
    let mdat = boxes.iter().find(|item| item.kind_is(b"mdat"));
    match (moov, mdat) {
        (Some(moov), Some(mdat)) => Ok(moov.offset < mdat.offset),
        _ => Err(format!("{} is missing moov or mdat.", path.display())),
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("clip.mp4");
    path.with_file_name(format!("{stem}.faststart.tmp"))
}

fn fsync_path(path: &Path) -> Result<(), String> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|err| format!("Could not reopen {} for fsync: {err}", path.display()))?;
    file.sync_all()
        .map_err(|err| format!("Could not fsync {}: {err}", path.display()))
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let backup = to.with_file_name(format!(
        "{}.faststart.bak",
        to.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("clip.mp4")
    ));
    let _ = std::fs::remove_file(&backup);
    if to.exists() {
        std::fs::rename(to, &backup).map_err(|err| {
            format!(
                "Could not park {} during fast-start replace: {err}",
                to.display()
            )
        })?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup);
            Ok(())
        }
        Err(err) => {
            if backup.exists() {
                let _ = std::fs::rename(&backup, to);
            }
            Err(format!(
                "Could not replace {} with fast-start file: {err}",
                to.display()
            ))
        }
    }
}

fn reject_unsupported(boxes: &[TopBox]) -> Result<(), String> {
    for item in boxes {
        if item.kind_is(b"moof") || item.kind_is(b"sidx") || item.kind_is(b"ssix") {
            return Err(format!(
                "Refusing fast-start on fragmented MP4 (found {}).",
                kind_label(item.kind)
            ));
        }
    }
    let moov_count = boxes.iter().filter(|item| item.kind_is(b"moov")).count();
    let mdat_count = boxes.iter().filter(|item| item.kind_is(b"mdat")).count();
    if moov_count != 1 {
        return Err("MP4 must contain exactly one moov atom.".into());
    }
    if mdat_count != 1 {
        return Err("MP4 must contain exactly one mdat atom.".into());
    }
    Ok(())
}

fn kind_label(kind: [u8; 4]) -> String {
    String::from_utf8_lossy(&kind).into_owned()
}

fn read_top_boxes(path: &Path) -> Result<Vec<TopBox>, String> {
    let mut file = File::open(path)
        .map_err(|err| format!("Could not open {} for fast-start: {err}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|err| format!("Could not stat {}: {err}", path.display()))?
        .len();
    let mut boxes = Vec::new();
    let mut offset = 0_u64;
    while offset + 8 <= file_len {
        let header = read_box_header(&mut file, offset, file_len)?;
        boxes.push(header);
        if header.size < header.header_len {
            return Err("MP4 box size is smaller than its header.".into());
        }
        offset = header.end();
    }
    if offset != file_len {
        return Err("MP4 has trailing bytes that are not a complete box.".into());
    }
    Ok(boxes)
}

fn read_box_header(file: &mut File, offset: u64, file_len: u64) -> Result<TopBox, String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("Could not seek MP4 box at {offset}: {err}"))?;
    let mut head = [0_u8; 8];
    file.read_exact(&mut head)
        .map_err(|err| format!("Could not read MP4 box header at {offset}: {err}"))?;
    let size32 = u32::from_be_bytes(head[0..4].try_into().unwrap());
    let kind = [head[4], head[5], head[6], head[7]];
    let (header_len, size) = match size32 {
        0 => (8_u64, file_len.saturating_sub(offset)),
        1 => {
            let mut wide = [0_u8; 8];
            file.read_exact(&mut wide)
                .map_err(|err| format!("Could not read 64-bit MP4 box size at {offset}: {err}"))?;
            let size = u64::from_be_bytes(wide);
            if size < 16 {
                return Err("64-bit MP4 box size is smaller than 16.".into());
            }
            (16_u64, size)
        }
        n => {
            let size = u64::from(n);
            if size < 8 {
                return Err("MP4 box size is smaller than 8.".into());
            }
            (8_u64, size)
        }
    };
    if offset.saturating_add(size) > file_len {
        return Err(format!(
            "MP4 box {} at {offset} extends past end of file.",
            kind_label(kind)
        ));
    }
    Ok(TopBox {
        offset,
        header_len,
        size,
        kind,
    })
}

fn rewrite_faststart(
    src: &Path,
    dest: &Path,
    boxes: &[TopBox],
    moov: TopBox,
    mdat: TopBox,
) -> Result<(), String> {
    let prefix: Vec<TopBox> = boxes
        .iter()
        .copied()
        .filter(|item| !item.kind_is(b"moov") && !item.kind_is(b"mdat"))
        .collect();
    let prefix_size: u64 = prefix.iter().map(|item| item.size).sum();
    let new_mdat = prefix_size.saturating_add(moov.size);
    let shift = new_mdat as i64 - mdat.offset as i64;

    let mut source = File::open(src)
        .map_err(|err| format!("Could not reopen {} for fast-start copy: {err}", src.display()))?;
    let mut moov_bytes = vec![0_u8; usize::try_from(moov.size).map_err(|_| {
        "moov atom is too large to rewrite in memory.".to_string()
    })?];
    source
        .seek(SeekFrom::Start(moov.offset))
        .and_then(|_| source.read_exact(&mut moov_bytes))
        .map_err(|err| format!("Could not read moov from {}: {err}", src.display()))?;
    if moov_bytes.windows(4).any(|window| window == b"cmov") {
        return Err("Compressed moov (cmov) is not supported.".into());
    }
    patch_chunk_offsets(&mut moov_bytes, shift)?;

    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dest)
        .map_err(|err| format!("Could not create {}: {err}", dest.display()))?;
    for item in &prefix {
        copy_range(&mut source, &mut output, item.offset, item.size)?;
    }
    output
        .write_all(&moov_bytes)
        .map_err(|err| format!("Could not write moov to {}: {err}", dest.display()))?;
    copy_range(&mut source, &mut output, mdat.offset, mdat.size)?;
    output
        .flush()
        .map_err(|err| format!("Could not flush {}: {err}", dest.display()))?;
    output
        .sync_all()
        .map_err(|err| format!("Could not fsync {}: {err}", dest.display()))?;
    Ok(())
}

fn copy_range(src: &mut File, dest: &mut File, offset: u64, size: u64) -> Result<(), String> {
    src.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("Could not seek source MP4 to {offset}: {err}"))?;
    let mut remaining = size;
    let mut buf = vec![0_u8; COPY_CHUNK.min(remaining as usize).max(1)];
    while remaining > 0 {
        let take = remaining.min(buf.len() as u64) as usize;
        src.read_exact(&mut buf[..take])
            .map_err(|err| format!("Could not copy MP4 bytes: {err}"))?;
        dest.write_all(&buf[..take])
            .map_err(|err| format!("Could not write fast-start bytes: {err}"))?;
        remaining -= take as u64;
    }
    Ok(())
}

fn patch_chunk_offsets(moov: &mut [u8], shift: i64) -> Result<u32, String> {
    if moov.len() < 8 {
        return Err("moov atom is truncated.".into());
    }
    walk_boxes(moov, 0, moov.len(), shift, false)
}

fn walk_boxes(
    data: &mut [u8],
    start: usize,
    end: usize,
    shift: i64,
    inside_stsd: bool,
) -> Result<u32, String> {
    let mut offset = start;
    let mut patched = 0_u32;
    while offset + 8 <= end {
        let size32 = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap());
        let kind = [data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]];
        let (header_len, size) = match size32 {
            0 => (8_usize, end.saturating_sub(offset)),
            1 => {
                if offset + 16 > end {
                    return Err("64-bit box inside moov is truncated.".into());
                }
                let size = usize::try_from(u64::from_be_bytes(
                    data[offset + 8..offset + 16].try_into().unwrap(),
                ))
                .map_err(|_| "64-bit box inside moov is too large.".to_string())?;
                (16_usize, size)
            }
            n => (8_usize, n as usize),
        };
        if size < header_len || offset + size > end {
            return Err("Invalid nested box inside moov.".into());
        }
        let payload = offset + header_len;
        let box_end = offset + size;
        if !inside_stsd && &kind == b"stco" {
            patched += patch_offset_table(&mut data[payload..box_end], shift, 4)?;
        } else if !inside_stsd && &kind == b"co64" {
            patched += patch_offset_table(&mut data[payload..box_end], shift, 8)?;
        } else if is_regular_container(kind) {
            patched += walk_boxes(data, payload, box_end, shift, false)?;
        } else if &kind == b"meta" && payload + 4 <= box_end {
            patched += walk_boxes(data, payload + 4, box_end, shift, false)?;
        } else if &kind == b"stsd" && payload + 8 <= box_end {
            patched += walk_boxes(data, payload + 8, box_end, shift, true)?;
        }
        offset = box_end;
    }
    Ok(patched)
}

fn is_regular_container(kind: [u8; 4]) -> bool {
    matches!(
        &kind,
        b"moov"
            | b"trak"
            | b"edts"
            | b"mdia"
            | b"minf"
            | b"dinf"
            | b"stbl"
            | b"mvex"
            | b"udta"
            | b"skip"
    )
}

fn patch_offset_table(payload: &mut [u8], shift: i64, entry_bytes: usize) -> Result<u32, String> {
    if payload.len() < 8 {
        return Err("Chunk offset table is truncated.".into());
    }
    let count = u32::from_be_bytes(payload[4..8].try_into().unwrap()) as usize;
    let needed = 8 + count.saturating_mul(entry_bytes);
    if payload.len() < needed {
        return Err("Chunk offset table is shorter than its entry count.".into());
    }
    for index in 0..count {
        let at = 8 + index * entry_bytes;
        if entry_bytes == 4 {
            let old = u32::from_be_bytes(payload[at..at + 4].try_into().unwrap());
            let new = apply_shift(u64::from(old), shift)?;
            if new > u64::from(u32::MAX) {
                return Err("fast-start moved a chunk offset past 4 GB; file needs co64.".into());
            }
            payload[at..at + 4].copy_from_slice(&(new as u32).to_be_bytes());
        } else {
            let old = u64::from_be_bytes(payload[at..at + 8].try_into().unwrap());
            let new = apply_shift(old, shift)?;
            payload[at..at + 8].copy_from_slice(&new.to_be_bytes());
        }
    }
    Ok(count as u32)
}

fn apply_shift(old: u64, shift: i64) -> Result<u64, String> {
    let next = i128::from(old) + i128::from(shift);
    if next < 0 {
        return Err("fast-start chunk offset underflowed.".into());
    }
    u64::try_from(next).map_err(|_| "fast-start chunk offset overflowed.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        faststart_mp4_in_place, patch_chunk_offsets, read_top_boxes, rewrite_faststart, TopBox,
    };
    use std::io::Write;

    fn box_bytes(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = 8 + payload.len();
        let mut out = Vec::with_capacity(size);
        out.extend_from_slice(&(size as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn nested(kind: &[u8; 4], children: &[u8]) -> Vec<u8> {
        box_bytes(kind, children)
    }

    fn stco(offsets: &[u32]) -> Vec<u8> {
        let mut payload = vec![0, 0, 0, 0];
        payload.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
        for offset in offsets {
            payload.extend_from_slice(&offset.to_be_bytes());
        }
        box_bytes(b"stco", &payload)
    }

    fn sample_mp4(mdat_payload: &[u8], chunk_offset: u32) -> Vec<u8> {
        let ftyp = box_bytes(b"ftyp", b"isom\0\0\0\0isomiso2");
        let mdat = box_bytes(b"mdat", mdat_payload);
        let stbl = nested(b"stbl", &stco(&[chunk_offset]));
        let minf = nested(b"minf", &stbl);
        let mdia = nested(b"mdia", &minf);
        let trak = nested(b"trak", &mdia);
        let moov = nested(b"moov", &trak);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&ftyp);
        bytes.extend_from_slice(&mdat);
        bytes.extend_from_slice(&moov);
        bytes
    }

    fn write_tmp(bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "replay-faststart-{}-{}.mp4",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        path
    }

    #[test]
    fn relocates_moov_and_patches_stco() {
        let ftyp_len = 8 + 16;
        let mdat_payload = b"H264AACPAYLOAD!!";
        let chunk = (ftyp_len + 8) as u32;
        let original = sample_mp4(mdat_payload, chunk);
        let src = write_tmp(&original);
        assert!(faststart_mp4_in_place(&src).unwrap());
        let rewritten = std::fs::read(&src).unwrap();
        let boxes = read_top_boxes(&src).unwrap();
        let kinds: Vec<[u8; 4]> = boxes.iter().map(|item| item.kind).collect();
        assert_eq!(kinds, [*b"ftyp", *b"moov", *b"mdat"]);
        assert!(rewritten.windows(mdat_payload.len()).any(|w| w == mdat_payload));
        let moov = boxes.iter().find(|item| item.kind_is(b"moov")).unwrap();
        let moov_bytes = &rewritten[moov.offset as usize..moov.end() as usize];
        let stco_at = moov_bytes.windows(4).position(|w| w == b"stco").unwrap();
        let table = &moov_bytes[stco_at + 4..];
        let patched = u32::from_be_bytes(table[8..12].try_into().unwrap());
        assert_eq!(patched, chunk + moov.size as u32);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(src.with_extension("faststart.tmp"));
    }

    #[test]
    fn already_faststarted_is_a_no_op() {
        let ftyp = box_bytes(b"ftyp", b"isom\0\0\0\0isomiso2");
        let stbl = nested(b"stbl", &stco(&[100]));
        let moov = nested(b"moov", &nested(b"trak", &nested(b"mdia", &nested(b"minf", &stbl))));
        let mdat = box_bytes(b"mdat", b"payload");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&ftyp);
        bytes.extend_from_slice(&moov);
        bytes.extend_from_slice(&mdat);
        let src = write_tmp(&bytes);
        assert!(!faststart_mp4_in_place(&src).unwrap());
        assert_eq!(std::fs::read(&src).unwrap(), bytes);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn patch_chunk_offsets_adds_shift() {
        let mut moov = nested(b"moov", &nested(b"trak", &stco(&[32, 64])));
        let count = patch_chunk_offsets(&mut moov, 16).unwrap();
        assert_eq!(count, 2);
        let stco_at = moov.windows(4).position(|w| w == b"stco").unwrap();
        let table = &moov[stco_at + 4..];
        assert_eq!(u32::from_be_bytes(table[8..12].try_into().unwrap()), 48);
        assert_eq!(u32::from_be_bytes(table[12..16].try_into().unwrap()), 80);
    }

    #[test]
    fn rewrite_keeps_mdat_payload_identical() {
        let ftyp_len = 8 + 16;
        let payload = vec![0x65_u8; 4096];
        let chunk = (ftyp_len + 8) as u32;
        let original = sample_mp4(&payload, chunk);
        let src = write_tmp(&original);
        let dest = src.with_extension("out.mp4");
        let boxes = read_top_boxes(&src).unwrap();
        let moov = boxes.iter().copied().find(|item| item.kind_is(b"moov")).unwrap();
        let mdat = boxes.iter().copied().find(|item| item.kind_is(b"mdat")).unwrap();
        rewrite_faststart(&src, &dest, &boxes, moov, mdat).unwrap();
        let rewritten = std::fs::read(&dest).unwrap();
        let dest_boxes = read_top_boxes(&dest).unwrap();
        let new_mdat = dest_boxes
            .iter()
            .find(|item| item.kind_is(b"mdat"))
            .unwrap();
        let copied = &rewritten[(new_mdat.offset + new_mdat.header_len) as usize
            ..new_mdat.end() as usize];
        assert_eq!(copied, payload.as_slice());
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn top_box_end_is_offset_plus_size() {
        let item = TopBox {
            offset: 24,
            header_len: 8,
            size: 100,
            kind: *b"mdat",
        };
        assert_eq!(item.end(), 124);
    }
}
