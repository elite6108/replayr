-- Detection catalog stays in public.games. Steam search hits and anonymous
-- play observations live in service-role tables and are never readable by anon.

alter table public.games
  add column if not exists catalog_source text not null default 'catalog';

alter table public.games
  drop constraint if exists games_catalog_source_check;

alter table public.games
  add constraint games_catalog_source_check
  check (catalog_source in ('catalog', 'staff', 'steam', 'observation'));

create table if not exists public.steam_apps (
  app_id bigint primary key,
  name text not null,
  cover_url text,
  updated_at timestamptz not null default now(),
  constraint steam_apps_cover_https check (cover_url is null or cover_url ~ '^https://')
);

create index if not exists steam_apps_name_idx on public.steam_apps (lower(name));

create table if not exists public.game_process_blocks (
  process_name text primary key,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.game_observations (
  process_name text primary key,
  window_title text not null,
  distinct_installs integer not null default 0 check (distinct_installs >= 0),
  title_votes integer not null default 0 check (title_votes >= 0),
  promoted_slug text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.game_observation_installs (
  process_name text not null references public.game_observations (process_name) on delete cascade,
  install_hash text not null,
  network_hash text not null,
  window_title text not null,
  last_seen_at timestamptz not null default now(),
  primary key (process_name, install_hash)
);

alter table public.steam_apps enable row level security;
alter table public.game_process_blocks enable row level security;
alter table public.game_observations enable row level security;
alter table public.game_observation_installs enable row level security;

revoke all on table public.steam_apps from public, anon, authenticated;
revoke all on table public.game_process_blocks from public, anon, authenticated;
revoke all on table public.game_observations from public, anon, authenticated;
revoke all on table public.game_observation_installs from public, anon, authenticated;

drop policy if exists steam_apps_deny on public.steam_apps;
drop policy if exists game_process_blocks_deny on public.game_process_blocks;
drop policy if exists game_observations_deny on public.game_observations;
drop policy if exists game_observation_installs_deny on public.game_observation_installs;

create policy steam_apps_deny on public.steam_apps
  for all to anon, authenticated using (false) with check (false);
create policy game_process_blocks_deny on public.game_process_blocks
  for all to anon, authenticated using (false) with check (false);
create policy game_observations_deny on public.game_observations
  for all to anon, authenticated using (false) with check (false);
create policy game_observation_installs_deny on public.game_observation_installs
  for all to anon, authenticated using (false) with check (false);

create or replace function public.record_game_observation(
  p_process text,
  p_title text,
  p_hash text,
  p_network text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_distinct integer;
  v_networks integer;
  v_title text;
  v_votes integer;
begin
  if p_process is null or p_title is null or p_hash is null or p_network is null
     or p_process !~ '^[a-z0-9][a-z0-9._+-]{0,78}\.exe$'
     or char_length(p_title) < 2 or char_length(p_title) > 80
     or p_hash !~ '^[a-f0-9]{64}$'
     or p_network !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('stored', false);
  end if;

  if exists (select 1 from public.game_process_blocks where process_name = p_process) then
    return jsonb_build_object('stored', false, 'blocked', true);
  end if;

  insert into public.game_observations (process_name, window_title)
  values (p_process, p_title)
  on conflict (process_name) do nothing;

  insert into public.game_observation_installs (process_name, install_hash, network_hash, window_title)
  values (p_process, p_hash, p_network, p_title)
  on conflict (process_name, install_hash) do update
    set window_title = excluded.window_title,
        network_hash = excluded.network_hash,
        last_seen_at = now();

  select count(*)::integer, count(distinct network_hash)::integer
    into v_distinct, v_networks
  from public.game_observation_installs
  where process_name = p_process;

  select window_title, count(*)::integer
    into v_title, v_votes
  from public.game_observation_installs
  where process_name = p_process
  group by window_title
  order by count(*) desc, window_title asc
  limit 1;

  update public.game_observations
  set window_title = coalesce(v_title, p_title),
      distinct_installs = coalesce(v_distinct, 0),
      title_votes = coalesce(v_votes, 0),
      last_seen_at = now()
  where process_name = p_process;

  return jsonb_build_object(
    'stored', true,
    'blocked', false,
    'distinctInstalls', coalesce(v_distinct, 0),
    'distinctNetworks', coalesce(v_networks, 0),
    'winningTitle', coalesce(v_title, p_title),
    'winningVotes', coalesce(v_votes, 0)
  );
end;
$$;

revoke all on function public.record_game_observation(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_game_observation(text, text, text, text) to service_role;

create or replace function public.game_by_process(p_process text)
returns setof public.games
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.games
  where exists (
    select 1
    from unnest(process_names) as process_name
    where lower(process_name) = lower(p_process)
  )
  limit 1;
$$;

revoke all on function public.game_by_process(text) from public, anon, authenticated;
grant execute on function public.game_by_process(text) to service_role;

grant select, insert, update, delete on table public.steam_apps to service_role;
grant select, insert, update, delete on table public.game_process_blocks to service_role;
grant select, insert, update, delete on table public.game_observations to service_role;
grant select, insert, update, delete on table public.game_observation_installs to service_role;

insert into public.staff_permissions (key, category, label, description, sort)
values (
  'games.manage',
  'catalog',
  'Manage game catalog',
  'Add and edit detection games, review anonymous play observations, and search Steam.',
  370
)
on conflict (key) do update set
  category = excluded.category,
  label = excluded.label,
  description = excluded.description,
  sort = excluded.sort;

insert into public.staff_role_permissions (role_id, permission_key)
select '00000000-0000-4000-8000-000000000002', 'games.manage'
where exists (select 1 from public.staff_roles where id = '00000000-0000-4000-8000-000000000002')
on conflict do nothing;
