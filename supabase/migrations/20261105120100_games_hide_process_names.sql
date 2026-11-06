-- The public games table stays readable for display columns. Process names
-- and created_by are not part of that surface. Service role still has both
-- for detection and staff review.

revoke select (process_names, created_by) on table public.games from public, anon, authenticated;
