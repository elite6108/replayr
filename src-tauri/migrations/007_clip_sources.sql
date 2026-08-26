CREATE TABLE clip_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT NOT NULL,
    source_instance_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary',
    start_hns INTEGER NOT NULL DEFAULT 0,
    duration_hns INTEGER,
    width INTEGER,
    height INTEGER,
    fps INTEGER,
    health TEXT NOT NULL DEFAULT 'valid',
    layout_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (clip_id) REFERENCES local_clips(local_id) ON DELETE CASCADE,
    UNIQUE (clip_id, source_instance_id)
);

CREATE INDEX idx_clip_sources_clip ON clip_sources(clip_id);
