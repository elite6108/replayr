-- Burned-in watermarked download derivatives. The clean master stays at
-- clips/{user}/{clip}/original.mp4 for playback/editing. For clips whose
-- uploader's plan requires a watermark, the desktop app renders a burned-in
-- sibling (clips/{user}/{clip}/watermarked-v{N}.mp4) in the background after
-- the original upload completes. The download endpoint serves only that
-- derivative for watermark-flagged clips; until it is ready it answers with a
-- "preparing" state and never falls back to the clean file.

alter table public.clips
  add column if not exists watermark_status text
    check (watermark_status in ('pending', 'rendering', 'uploading', 'ready', 'failed'));

-- Set only after the derivative render and upload fully succeed.
alter table public.clips
  add column if not exists watermarked_key text;

-- WATERMARK_RENDER_VERSION the ready derivative was rendered with. Bumping the
-- Worker constant invalidates old derivatives without touching rows.
alter table public.clips
  add column if not exists watermark_render_version integer;

-- Upload sessions now also track derivative uploads. Quota reservation and
-- release only ever apply to purpose = 'original' sessions.
alter table public.upload_sessions
  add column if not exists purpose text not null default 'original'
    check (purpose in ('original', 'watermark'));

-- Expose derivative state (not the storage key) to clients, matching the
-- existing column-level grant style.
revoke select on table public.clips from anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count,
  watermark, watermark_status, watermark_render_version
) on table public.clips to anon, authenticated;
