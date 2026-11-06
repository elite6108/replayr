-- A table-level SELECT still covers every column, so revoking one column does
-- not hide it. Grant the public roles only the display columns.

revoke select on table public.games from public, anon, authenticated;

grant select (
  id,
  slug,
  name,
  publisher,
  cover_url,
  icon_url,
  created_at,
  catalog_source,
  igdb_id,
  steam_app_id,
  aliases,
  parent_game_id,
  status
) on table public.games to anon, authenticated;
