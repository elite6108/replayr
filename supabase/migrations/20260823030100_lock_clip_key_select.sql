-- Table-level SELECT still exposed storage_key. Grant only metadata columns.
revoke select on table public.clips from anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count
) on table public.clips to anon, authenticated;
