ALTER TABLE local_clips
ADD COLUMN capture_kind TEXT NOT NULL DEFAULT 'clip'
CHECK (capture_kind IN ('clip', 'recording', 'screenshot'));

UPDATE local_clips
SET capture_kind = 'screenshot'
WHERE lower(file_path) LIKE '%.bmp'
   OR lower(file_path) LIKE '%.png'
   OR lower(file_path) LIKE '%.jpg'
   OR lower(file_path) LIKE '%.jpeg'
   OR lower(file_path) LIKE '%.webp';

CREATE INDEX idx_local_clips_capture_kind
ON local_clips(capture_kind, created_at DESC);
