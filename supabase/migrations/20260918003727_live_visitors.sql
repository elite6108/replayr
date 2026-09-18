-- Ephemeral presence for the admin Live visitors view. Service-role only. No IP warehouse.

create table if not exists public.live_visitors (
  visitor_key text primary key,
  ip inet,
  country text,
  city text,
  colo text,
  path text,
  surface text not null,
  user_id uuid references auth.users (id) on delete set null,
  user_agent text,
  last_seen timestamptz not null default now(),
  constraint live_visitors_key_len check (char_length(visitor_key) between 8 and 80),
  constraint live_visitors_surface_check check (surface in ('web', 'coming-soon', 'desktop', 'api', 'admin')),
  constraint live_visitors_country_check check (country is null or country ~ '^[A-Z]{2}$'),
  constraint live_visitors_path_len check (path is null or char_length(path) <= 160),
  constraint live_visitors_city_len check (city is null or char_length(city) <= 80),
  constraint live_visitors_colo_len check (colo is null or char_length(colo) <= 16),
  constraint live_visitors_ua_len check (user_agent is null or char_length(user_agent) <= 180)
);

create index if not exists live_visitors_last_seen_idx on public.live_visitors (last_seen desc);
create index if not exists live_visitors_user_idx on public.live_visitors (user_id) where user_id is not null;

alter table public.live_visitors enable row level security;
alter table public.live_visitors force row level security;

revoke all on table public.live_visitors from public, anon, authenticated;
grant select, insert, update, delete on table public.live_visitors to service_role;

create or replace function public.upsert_live_visitor(
  p_visitor_key text,
  p_ip text,
  p_country text,
  p_city text,
  p_colo text,
  p_path text,
  p_surface text,
  p_user_id uuid,
  p_user_agent text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip inet;
begin
  if p_visitor_key is null or char_length(trim(p_visitor_key)) < 8 then
    raise exception 'invalid visitor key';
  end if;
  begin
    v_ip := nullif(trim(p_ip), '')::inet;
  exception
    when others then
      v_ip := null;
  end;

  insert into public.live_visitors (
    visitor_key, ip, country, city, colo, path, surface, user_id, user_agent, last_seen
  ) values (
    trim(p_visitor_key),
    v_ip,
    nullif(upper(trim(p_country)), ''),
    nullif(trim(p_city), ''),
    nullif(trim(p_colo), ''),
    nullif(trim(p_path), ''),
    p_surface,
    p_user_id,
    nullif(trim(p_user_agent), ''),
    now()
  )
  on conflict (visitor_key) do update
    set
      ip = excluded.ip,
      country = excluded.country,
      city = excluded.city,
      colo = excluded.colo,
      path = excluded.path,
      surface = excluded.surface,
      user_id = coalesce(excluded.user_id, public.live_visitors.user_id),
      user_agent = excluded.user_agent,
      last_seen = excluded.last_seen
    where
      public.live_visitors.last_seen < excluded.last_seen - interval '10 seconds'
      or public.live_visitors.path is distinct from excluded.path
      or public.live_visitors.user_id is distinct from excluded.user_id
      or public.live_visitors.surface is distinct from excluded.surface;
end;
$$;

revoke all on function public.upsert_live_visitor(text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_live_visitor(text, text, text, text, text, text, text, uuid, text) to service_role;

create or replace function public.list_live_visitors()
returns table (
  visitor_key text,
  ip text,
  country text,
  city text,
  colo text,
  path text,
  surface text,
  user_id uuid,
  user_agent text,
  last_seen timestamptz,
  handle text,
  display_name text,
  email text
)
language sql
security definer
set search_path = public
as $$
  select
    v.visitor_key,
    host(v.ip) as ip,
    v.country,
    v.city,
    v.colo,
    v.path,
    v.surface,
    v.user_id,
    v.user_agent,
    v.last_seen,
    p.username as handle,
    p.display_name,
    u.email::text
  from public.live_visitors v
  left join public.profiles p on p.id = v.user_id
  left join auth.users u on u.id = v.user_id
  where v.last_seen > now() - interval '2 minutes'
  order by v.last_seen desc
  limit 500;
$$;

revoke all on function public.list_live_visitors() from public, anon, authenticated;
grant execute on function public.list_live_visitors() to service_role;

create or replace function public.cleanup_live_visitors()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.live_visitors where last_seen < now() - interval '15 minutes';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_live_visitors() from public, anon, authenticated;
grant execute on function public.cleanup_live_visitors() to service_role;
