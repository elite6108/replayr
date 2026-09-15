//! Saving screenshots to disk and recording them in the local database.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// A local calendar timestamp, split out so filename formatting is testable without the OS clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalStamp {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub millis: u16,
}

impl LocalStamp {
    #[cfg(windows)]
    pub fn now() -> Self {
        let time = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        Self {
            year: time.wYear,
            month: time.wMonth,
            day: time.wDay,
            hour: time.wHour,
            minute: time.wMinute,
            second: time.wSecond,
            millis: time.wMilliseconds,
        }
    }
}

/// `Replayr-YYYYMMDD-HHMMSS-mmm` — sorts chronologically and never collides within a millisecond.
pub fn file_stem(stamp: LocalStamp) -> String {
    format!(
        "Replayr-{:04}{:02}{:02}-{:02}{:02}{:02}-{:03}",
        stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute, stamp.second, stamp.millis
    )
}

/// A process-unique local id. Millisecond clock plus a counter, so two screenshots in the same
/// millisecond still get distinct primary keys.
pub fn new_id() -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    format!("shot-{millis}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Write `bytes` to `dir/{stem}.{ext}` without ever overwriting an existing file.
///
/// Bytes go to a `.part` file first and are renamed into place, so a crash mid-write never leaves
/// a truncated PNG that looks like a real screenshot. On a name collision a `-2`, `-3`… suffix is
/// tried.
pub fn write_new(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("Could not create the screenshots folder: {err}"))?;
    for attempt in 1..=100u32 {
        let name = if attempt == 1 { format!("{stem}.{ext}") } else { format!("{stem}-{attempt}.{ext}") };
        let target = dir.join(&name);
        if target.exists() {
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&part) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("Could not save the screenshot: {err}")),
        };
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        if let Err(err) = written {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Could not save the screenshot: {err}"));
        }
        if target.exists() {
            // Lost a race for this name after all; try the next one.
            let _ = std::fs::remove_file(&part);
            continue;
        }
        if let Err(err) = std::fs::rename(&part, &target) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Could not save the screenshot: {err}"));
        }
        return Ok(target);
    }
    Err("Could not find a free file name for the screenshot.".into())
}

/// A screenshot as the Library sees it. Hand-mirrored with `Screenshot` in src/types/screenshot.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRecord {
    pub id: String,
    pub file_path: String,
    pub thumb_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
    pub created_at: String,
    pub cloud_id: Option<String>,
    pub slug: Option<String>,
    pub share_url: Option<String>,
    pub upload_status: String,
    pub upload_error: Option<String>,
}

const COLUMNS: &str = "id, file_path, thumb_path, width, height, file_size, created_at, cloud_id, slug, \
                       share_url, upload_status, upload_error";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScreenshotRecord> {
    Ok(ScreenshotRecord {
        id: row.get(0)?,
        file_path: row.get(1)?,
        thumb_path: row.get(2)?,
        width: row.get::<_, i64>(3)?.max(0) as u32,
        height: row.get::<_, i64>(4)?.max(0) as u32,
        file_size: row.get::<_, i64>(5)?.max(0) as u64,
        created_at: row.get(6)?,
        cloud_id: row.get(7)?,
        slug: row.get(8)?,
        share_url: row.get(9)?,
        upload_status: row.get(10)?,
        upload_error: row.get(11)?,
    })
}

pub fn insert(conn: &Connection, record: &ScreenshotRecord) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO screenshots ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
        params![
            record.id,
            record.file_path,
            record.thumb_path,
            record.width,
            record.height,
            record.file_size as i64,
            record.created_at,
            record.cloud_id,
            record.slug,
            record.share_url,
            record.upload_status,
            record.upload_error,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<ScreenshotRecord>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM screenshots WHERE id = ?1"), [id], from_row)
        .optional()
}

/// Newest first. Rows marked `deleted` are hidden.
pub fn list(conn: &Connection, limit: u32) -> rusqlite::Result<Vec<ScreenshotRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM screenshots WHERE upload_status <> 'deleted' \
         ORDER BY created_at DESC, id DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit.clamp(1, 1000)], from_row)?;
    rows.collect()
}

pub fn remove(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM screenshots WHERE id = ?1", [id])? > 0)
}

pub fn set_file_path(conn: &Connection, id: &str, file_path: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("UPDATE screenshots SET file_path = ?1 WHERE id = ?2", params![file_path, id])? > 0)
}

pub fn set_upload(
    conn: &Connection,
    id: &str,
    upload_status: &str,
    cloud_id: Option<&str>,
    slug: Option<&str>,
    share_url: Option<&str>,
    upload_error: Option<&str>,
) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE screenshots SET upload_status = ?1, cloud_id = ?2, slug = ?3, share_url = ?4, upload_error = ?5 WHERE id = ?6",
        params![upload_status, cloud_id, slug, share_url, upload_error, id],
    )? > 0)
}

/// Oldest cloud copies that the Worker evicted. Keep the local PNG; hide the dead share link.
pub fn mark_evicted_by_cloud_ids(conn: &Connection, cloud_ids: &[String]) -> rusqlite::Result<u64> {
    let mut changed = 0u64;
    for cloud_id in cloud_ids {
        changed += conn.execute(
            "UPDATE screenshots SET upload_status = 'evicted', share_url = NULL, upload_error = NULL WHERE cloud_id = ?1",
            [cloud_id],
        )? as u64;
    }
    Ok(changed)
}

/// ISO-8601 UTC, lexically sortable, for `created_at`.
pub fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    iso_from_unix_millis(millis)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` from Unix milliseconds. Civil-from-days per Howard Hinnant, kept
/// local so this module does not depend on recording code or pull in a date crate.
pub fn iso_from_unix_millis(unix_millis: u64) -> String {
    let secs = unix_millis / 1000;
    let millis = unix_millis % 1000;
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (hour, minute, second) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn stamp() -> LocalStamp {
        LocalStamp { year: 2026, month: 9, day: 5, hour: 7, minute: 3, second: 9, millis: 42 }
    }

    #[test]
    fn file_stem_is_zero_padded_and_sortable() {
        assert_eq!(file_stem(stamp()), "Replayr-20260905-070309-042");
    }

    #[test]
    fn ids_are_unique_within_a_millisecond() {
        let ids: std::collections::HashSet<String> = (0..500).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 500);
    }

    #[test]
    fn write_new_never_overwrites_and_leaves_no_part_files() {
        let dir = tempdir().unwrap();
        let first = write_new(dir.path(), "Replayr-x", "png", b"one").unwrap();
        let second = write_new(dir.path(), "Replayr-x", "png", b"two").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"one", "first file untouched");
        assert!(second.file_name().unwrap().to_string_lossy().ends_with("-2.png"));
        let leftovers = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().path().extension().is_some_and(|ext| ext == "part"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn database_round_trip_and_listing() {
        let dir = tempdir().unwrap();
        let conn = crate::database::open_path(&dir.path().join("db.sqlite")).unwrap();
        crate::database::migrate(&conn).unwrap();

        let mut record = ScreenshotRecord {
            id: "shot-1".into(),
            file_path: "C:/shots/a.png".into(),
            thumb_path: None,
            width: 640,
            height: 360,
            file_size: 1234,
            created_at: "2026-09-15T10:00:00.000Z".into(),
            cloud_id: None,
            slug: None,
            share_url: None,
            upload_status: "local".into(),
            upload_error: None,
        };
        insert(&conn, &record).unwrap();
        record.id = "shot-2".into();
        record.created_at = "2026-09-15T11:00:00.000Z".into();
        record.upload_status = "deleted".into();
        insert(&conn, &record).unwrap();

        assert_eq!(get(&conn, "shot-1").unwrap().unwrap().width, 640);
        let listed = list(&conn, 10).unwrap();
        assert_eq!(listed.len(), 1, "deleted rows are hidden");
        assert!(remove(&conn, "shot-1").unwrap());
        assert!(get(&conn, "shot-1").unwrap().is_none());
    }

    #[test]
    fn database_rejects_an_unknown_status() {
        let dir = tempdir().unwrap();
        let conn = crate::database::open_path(&dir.path().join("db.sqlite")).unwrap();
        crate::database::migrate(&conn).unwrap();
        let bad = conn.execute(
            "INSERT INTO screenshots (id, file_path, width, height, file_size, created_at, upload_status) \
             VALUES ('x', 'p', 1, 1, 0, 't', 'bogus')",
            [],
        );
        assert!(bad.is_err(), "the CHECK constraint must reject unknown states");
    }

    #[test]
    fn iso_from_unix_millis_matches_known_instants() {
        assert_eq!(iso_from_unix_millis(0), "1970-01-01T00:00:00.000Z");
        // 2000-02-29 (leap day) 12:34:56.789 UTC.
        assert_eq!(iso_from_unix_millis(951_827_696_789), "2000-02-29T12:34:56.789Z");
        // 2026-09-15 00:00:00 UTC.
        assert_eq!(iso_from_unix_millis(1_789_430_400_000), "2026-09-15T00:00:00.000Z");
    }

    #[test]
    fn now_iso_is_well_formed() {
        let value = now_iso();
        assert_eq!(value.len(), "2026-09-15T10:00:00.000Z".len());
        assert_eq!(&value[10..11], "T");
        assert!(value.ends_with('Z'));
    }
}
