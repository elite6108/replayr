CREATE TABLE watermark_queue (
    cloud_clip_id TEXT PRIMARY KEY,
    local_clip_id TEXT NOT NULL,
    render_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_watermark_queue_due ON watermark_queue(status, next_attempt_at);
