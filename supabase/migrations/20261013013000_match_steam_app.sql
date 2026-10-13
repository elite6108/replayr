create or replace function public.match_steam_app(p_title text)
returns table (app_id bigint, name text, cover_url text)
language sql
stable
security definer
set search_path = public
as $$
  select app_id, name, cover_url
  from public.steam_apps
  where lower(name) = lower(btrim(p_title))
  limit 2;
$$;

revoke all on function public.match_steam_app(text) from public, anon, authenticated;
grant execute on function public.match_steam_app(text) to service_role;
