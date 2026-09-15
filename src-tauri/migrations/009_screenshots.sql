-- Region screenshots. Deliberately a separate table from local_clips: screenshots are not clips,
-- have no duration, sources, editor or Instant Replay lineage, and must not take slots in the
-- clip library's listing.
CREATE TABLE screenshots (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    thumb_path TEXT,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    file_size INTEGER NOT NULL CHECK (file_size >= 0),
    created_at TEXT NOT NULL,
    cloud_id TEXT,
    slug TEXT,
    share_url TEXT,
    upload_status TEXT NOT NULL DEFAULT 'local'
        CHECK (upload_status IN ('local', 'uploading', 'ready', 'failed', 'evicted', 'deleted')),
    upload_error TEXT
);

CREATE INDEX screenshots_created_at_idx ON screenshots (created_at DESC);
CREATE UNIQUE INDEX screenshots_cloud_id_idx ON screenshots (cloud_id) WHERE cloud_id IS NOT NULL;
