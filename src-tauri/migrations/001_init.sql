CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE local_clips (
    local_id TEXT PRIMARY KEY,
    cloud_clip_id TEXT,
    file_path TEXT NOT NULL,
    thumbnail_path TEXT,
    game_id TEXT,
    created_at TEXT NOT NULL,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    fps INTEGER,
    file_size INTEGER,
    upload_status TEXT NOT NULL DEFAULT 'local',
    favorite INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    description TEXT
);

CREATE TABLE upload_queue (
    local_clip_id TEXT PRIMARY KEY,
    cloud_clip_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    uploaded_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_local_clips_created_at ON local_clips(created_at DESC);
CREATE INDEX idx_upload_queue_status ON upload_queue(status);
