-- Privileged quota + admin stats. Clients must not execute these.
-- Old auth.uid() overloads are dropped after the replacements exist.

create or replace function public.add_storage_used_for(p_user_id uuid, p_bytes bigint)
returns table(storage_used_bytes bigint, storage_limit_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  current public.user_storage%rowtype;
begin
  if p_user_id is null or p_bytes is null or p_bytes < 0 or p_bytes > 10737418240 then
    raise exception 'invalid size' using errcode = '22023';
  end if;

  select *
    into current
    from public.user_storage
   where user_id = p_user_id
   for update;

  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  if current.storage_used_bytes + p_bytes > current.storage_limit_bytes then
    raise exception 'This clip would exceed your cloud storage limit.' using errcode = 'P0001';
  end if;

  return query
    update public.user_storage
       set storage_used_bytes = public.user_storage.storage_used_bytes + p_bytes
     where user_id = p_user_id
     returning public.user_storage.storage_used_bytes, public.user_storage.storage_limit_bytes;
end;
$$;

create or replace function public.release_storage_used_for(p_user_id uuid, p_bytes bigint)
returns table(storage_used_bytes bigint, storage_limit_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  current public.user_storage%rowtype;
begin
  if p_user_id is null or p_bytes is null or p_bytes < 0 or p_bytes > 10737418240 then
    raise exception 'invalid size' using errcode = '22023';
  end if;

  select *
    into current
    from public.user_storage
   where user_id = p_user_id
   for update;

  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  return query
    update public.user_storage
       set storage_used_bytes = greatest(0, public.user_storage.storage_used_bytes - p_bytes)
     where user_id = p_user_id
     returning public.user_storage.storage_used_bytes, public.user_storage.storage_limit_bytes;
end;
$$;

revoke all on function public.add_storage_used_for(uuid, bigint) from public, anon, authenticated;
revoke all on function public.release_storage_used_for(uuid, bigint) from public, anon, authenticated;
grant execute on function public.add_storage_used_for(uuid, bigint) to service_role;
grant execute on function public.release_storage_used_for(uuid, bigint) to service_role;

drop function if exists public.add_storage_used(bigint);
drop function if exists public.release_storage_used(bigint);

revoke update on table public.profiles from authenticated;
grant update (username, display_name, avatar_url, bio, is_private)
  on table public.profiles to authenticated;

create or replace function public.admin_auth_stats()
returns table(
  users bigint,
  active1d bigint,
  active7d bigint,
  active30d bigint,
  storage_used_bytes bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from auth.users)::bigint,
    (select count(*) from auth.users where last_sign_in_at > now() - interval '1 day')::bigint,
    (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days')::bigint,
    (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days')::bigint,
    (select coalesce(sum(user_storage.storage_used_bytes), 0) from public.user_storage)::bigint;
$$;

revoke all on function public.admin_auth_stats() from public, anon, authenticated;
grant execute on function public.admin_auth_stats() to service_role;
