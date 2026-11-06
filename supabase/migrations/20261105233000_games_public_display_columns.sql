-- Drop the extra catalog identifiers from the public column grant.
-- Service role is unchanged and still reads every column.

revoke select on table public.games from public, anon, authenticated;

grant select (
  id,
  slug,
  name,
  publisher,
  cover_url,
  icon_url,
  created_at,
  parent_game_id,
  status
) on table public.games to anon, authenticated;
