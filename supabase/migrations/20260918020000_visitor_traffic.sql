-- Historical visitor traffic (no IPs). One row per visitor per UTC hour.
-- Live presence stays ephemeral; this table is for day/time comparison.

create table if not exists public.visitor_traffic (
  bucket_start timestamptz not null,
  visitor_key text not null,
  surface text not null,
  country text,
  path text,
  signed_in boolean not null default false,
  ping_count integer not null default 1,
  last_seen timestamptz not null default now(),
  primary key (bucket_start, visitor_key),
  constraint visitor_traffic_key_len check (char_length(visitor_key) between 8 and 80),
  constraint visitor_traffic_surface_check check (surface in ('web', 'coming-soon', 'desktop', 'api', 'admin')),
  constraint visitor_traffic_country_check check (country is null or country ~ '^[A-Z]{2}$'),
  constraint visitor_traffic_path_len check (path is null or char_length(path) <= 160),
  constraint visitor_traffic_pings_check check (ping_count >= 1)
);

create index if not exists visitor_traffic_last_seen_idx on public.visitor_traffic (last_seen desc);
create index if not exists visitor_traffic_surface_idx on public.visitor_traffic (bucket_start, surface);

alter table public.visitor_traffic enable row level security;
alter table public.visitor_traffic force row level security;

revoke all on table public.visitor_traffic from public, anon, authenticated;
grant select, insert, update, delete on table public.visitor_traffic to service_role;

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
  v_country text;
  v_path text;
  v_surface text;
  v_ua text;
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
  v_country := nullif(upper(trim(p_country)), '');
  v_path := nullif(trim(p_path), '');
  v_surface := p_surface;
  v_ua := nullif(trim(p_user_agent), '');

  insert into public.live_visitors (
    visitor_key, ip, country, city, colo, path, surface, user_id, user_agent, last_seen
  ) values (
    trim(p_visitor_key),
    v_ip,
    v_country,
    nullif(trim(p_city), ''),
    nullif(trim(p_colo), ''),
    v_path,
    v_surface,
    p_user_id,
    v_ua,
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

  insert into public.visitor_traffic (
    bucket_start, visitor_key, surface, country, path, signed_in, ping_count, last_seen
  ) values (
    date_trunc('hour', now()),
    trim(p_visitor_key),
    v_surface,
    v_country,
    v_path,
    p_user_id is not null,
    1,
    now()
  )
  on conflict (bucket_start, visitor_key) do update
    set
      surface = excluded.surface,
      country = coalesce(excluded.country, public.visitor_traffic.country),
      path = coalesce(excluded.path, public.visitor_traffic.path),
      signed_in = public.visitor_traffic.signed_in or excluded.signed_in,
      ping_count = public.visitor_traffic.ping_count + 1,
      last_seen = excluded.last_seen
    where
      public.visitor_traffic.last_seen < excluded.last_seen - interval '10 seconds'
      or public.visitor_traffic.path is distinct from excluded.path
      or public.visitor_traffic.surface is distinct from excluded.surface
      or public.visitor_traffic.signed_in is distinct from (public.visitor_traffic.signed_in or excluded.signed_in);
end;
$$;

revoke all on function public.upsert_live_visitor(text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_live_visitor(text, text, text, text, text, text, text, uuid, text) to service_role;

create or replace function public.visitor_traffic_report(
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text,
  p_tz text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gran text;
  v_tz text;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid range';
  end if;
  if p_to > p_from + interval '400 days' then
    raise exception 'range too large';
  end if;
  v_gran := case p_granularity
    when 'hour' then 'hour'
    when 'week' then 'week'
    when 'month' then 'month'
    else 'day'
  end;
  v_tz := coalesce(nullif(trim(p_tz), ''), 'UTC');
  begin
    perform timezone(v_tz, now());
  exception
    when others then
      v_tz := 'UTC';
  end;

  return jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'uniqueVisitors', count(distinct visitor_key),
        'signedIn', count(distinct visitor_key) filter (where signed_in),
        'pings', coalesce(sum(ping_count), 0)
      )
      from public.visitor_traffic
      where bucket_start >= p_from and bucket_start < p_to
    ),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bucketStart', s.bucket_start,
        'uniqueVisitors', s.unique_visitors,
        'signedIn', s.signed_in,
        'pings', s.pings
      ) order by s.bucket_start)
      from (
        select
          (date_trunc(v_gran, bucket_start at time zone v_tz) at time zone v_tz) as bucket_start,
          count(distinct visitor_key) as unique_visitors,
          count(distinct visitor_key) filter (where signed_in) as signed_in,
          coalesce(sum(ping_count), 0) as pings
        from public.visitor_traffic
        where bucket_start >= p_from and bucket_start < p_to
        group by 1
      ) s
    ), '[]'::jsonb),
    'surfaces', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', s.surface,
        'uniqueVisitors', s.unique_visitors,
        'pings', s.pings
      ) order by s.unique_visitors desc)
      from (
        select
          surface,
          count(distinct visitor_key) as unique_visitors,
          coalesce(sum(ping_count), 0) as pings
        from public.visitor_traffic
        where bucket_start >= p_from and bucket_start < p_to
        group by surface
      ) s
    ), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', s.country,
        'uniqueVisitors', s.unique_visitors,
        'pings', s.pings
      ) order by s.unique_visitors desc)
      from (
        select
          coalesce(country, 'ZZ') as country,
          count(distinct visitor_key) as unique_visitors,
          coalesce(sum(ping_count), 0) as pings
        from public.visitor_traffic
        where bucket_start >= p_from and bucket_start < p_to
        group by 1
        order by 2 desc
        limit 20
      ) s
    ), '[]'::jsonb),
    'paths', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', s.path,
        'uniqueVisitors', s.unique_visitors,
        'pings', s.pings
      ) order by s.unique_visitors desc)
      from (
        select
          coalesce(path, '/') as path,
          count(distinct visitor_key) as unique_visitors,
          coalesce(sum(ping_count), 0) as pings
        from public.visitor_traffic
        where bucket_start >= p_from and bucket_start < p_to
        group by 1
        order by 2 desc
        limit 20
      ) s
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'hour', s.hour,
        'uniqueVisitors', s.unique_visitors,
        'pings', s.pings
      ) order by s.hour)
      from (
        select
          extract(hour from bucket_start at time zone v_tz)::int as hour,
          count(distinct visitor_key) as unique_visitors,
          coalesce(sum(ping_count), 0) as pings
        from public.visitor_traffic
        where bucket_start >= p_from and bucket_start < p_to
        group by 1
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.visitor_traffic_report(timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.visitor_traffic_report(timestamptz, timestamptz, text, text) to service_role;

create or replace function public.cleanup_visitor_traffic()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.visitor_traffic where bucket_start < now() - interval '400 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_visitor_traffic() from public, anon, authenticated;
grant execute on function public.cleanup_visitor_traffic() to service_role;
