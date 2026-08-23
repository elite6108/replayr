-- Lock clip object keys and creator-application review fields.
-- Worker already reads/writes these via the service role.

revoke all on function public.get_clip_for_playback(text) from public, anon, authenticated;

revoke select on table public.clips from anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count
) on table public.clips to anon, authenticated;

revoke insert, update, delete on table public.clips from authenticated;
grant update (title, visibility, description)
  on table public.clips to authenticated;

revoke all on table public.upload_sessions from public, anon, authenticated;
grant all on table public.upload_sessions to service_role;

revoke insert on table public.creator_applications from authenticated;
grant insert (user_id, display_name, channel_url, game, note)
  on table public.creator_applications to authenticated;
