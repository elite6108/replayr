-- Column grants from games_public_columns survive a later table-level revoke.
-- Drop the catalog identifiers, then grant only the display columns again.
-- Service role is unchanged and still reads every column.

revoke select (catalog_source, igdb_id, steam_app_id, aliases)
  on table public.games
  from public, anon, authenticated;

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

-- The pending-game cap is 10, matching the worker message. The lock stops two
-- requests for the same user from both passing the count.
create or replace function public.create_user_pending_game(
  p_user_id uuid,
  p_slug_base text,
  p_name text,
  p_alias text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  open_count integer;
  slug text;
  attempt integer;
begin
  if p_user_id is null
     or p_slug_base is null
     or p_name is null
     or p_alias is null
     or length(trim(p_slug_base)) = 0
     or length(trim(p_name)) = 0
     or length(p_name) > 80
     or length(p_slug_base) > 48
     or length(p_alias) > 80 then
    raise exception 'invalid game' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text)::bigint);

  select count(*)::integer
    into open_count
    from public.games
   where created_by = p_user_id
     and status = 'pending'
     and catalog_source = 'user';

  if open_count >= 10 then
    raise exception 'pending game cap' using errcode = 'P0001';
  end if;

  for attempt in 0..4 loop
    slug := case
      when attempt = 0 then p_slug_base
      else p_slug_base || '-' || (attempt + 1)::text
    end;
    begin
      insert into public.games (
        slug,
        name,
        aliases,
        status,
        catalog_source,
        created_by,
        process_names
      ) values (
        slug,
        p_name,
        array[p_alias],
        'pending',
        'user',
        p_user_id,
        '{}'
      );
      return slug;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'Could not add that game.' using errcode = '23505';
end;
$$;

revoke all on function public.create_user_pending_game(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_user_pending_game(uuid, text, text, text) to service_role;
