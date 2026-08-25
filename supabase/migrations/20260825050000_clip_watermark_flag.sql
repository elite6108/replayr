-- Per-clip watermark flag. Clips now upload clean and the players draw the mark,
-- so the flag records whether the uploader's plan required one at upload time.

-- Rows that already exist were burned in by the desktop app before upload, so they
-- default to false to avoid drawing a second mark on top. New uploads are clean.
alter table public.clips
  add column if not exists watermark boolean not null default false;

alter table public.clips
  alter column watermark set default true;

revoke select on table public.clips from anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count,
  watermark
) on table public.clips to anon, authenticated;
