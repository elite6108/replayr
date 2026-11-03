-- Server-side game identity. Existing games stay the catalog; clips.game_id already points here.

alter table public.games
  add column if not exists igdb_id bigint,
  add column if not exists steam_app_id bigint,
  add column if not exists aliases text[] not null default '{}',
  add column if not exists parent_game_id uuid references public.games (id),
  add column if not exists status text not null default 'confirmed';

alter table public.games drop constraint if exists games_status_check;
alter table public.games
  add constraint games_status_check check (status in ('confirmed', 'pending'));

alter table public.games drop constraint if exists games_catalog_source_check;
alter table public.games
  add constraint games_catalog_source_check
  check (catalog_source in ('catalog', 'staff', 'steam', 'observation', 'igdb', 'user'));

create unique index if not exists games_igdb_id_idx
  on public.games (igdb_id) where igdb_id is not null;
create unique index if not exists games_steam_app_id_idx
  on public.games (steam_app_id) where steam_app_id is not null;

update public.games child
set parent_game_id = parent.id
from public.games parent
where child.slug in ('fivem', 'five-m')
  and parent.slug = 'gta-v'
  and child.parent_game_id is null;

create table if not exists public.game_matches (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  exe_name text,
  launcher_kind text,
  launcher_id text,
  window_title text,
  status text not null default 'pending' check (status in ('confirmed', 'pending')),
  confirmation_count integer not null default 0 check (confirmation_count >= 0),
  created_at timestamptz not null default now(),
  constraint game_matches_kind_check check (launcher_kind is null or launcher_kind in ('steam', 'epic', 'xbox')),
  constraint game_matches_has_key check (exe_name is not null or launcher_id is not null)
);

create unique index if not exists game_matches_exe_game_idx
  on public.game_matches (exe_name, game_id) where exe_name is not null;
create unique index if not exists game_matches_launcher_game_idx
  on public.game_matches (launcher_kind, launcher_id, game_id) where launcher_id is not null;
create index if not exists game_matches_exe_idx on public.game_matches (exe_name);

create table if not exists public.game_match_confirmations (
  match_id uuid not null references public.game_matches (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

create table if not exists public.game_import_state (
  source text primary key check (source in ('igdb', 'steam')),
  cursor text,
  updated_at timestamptz not null default now()
);

alter table public.clips
  add column if not exists capture_exe text,
  add column if not exists capture_launcher_kind text,
  add column if not exists capture_launcher_id text,
  add column if not exists capture_title text;

-- Staff catalog exes are already trusted. Globs stay on process_names for the matcher.
insert into public.game_matches (game_id, exe_name, status, confirmation_count)
select games.id, lower(btrim(process_name)), 'confirmed', 3
from public.games
cross join lateral unnest(games.process_names) as process_name
where btrim(process_name) <> ''
  and process_name not like '%*%'
  and lower(process_name) ~ '\.exe$'
on conflict (exe_name, game_id) where exe_name is not null do nothing;

insert into public.game_process_blocks (process_name, note)
values
  ('replay.exe', 'app'),
  ('replayr.exe', 'app'),
  ('explorer.exe', 'desktop'),
  ('searchhost.exe', 'desktop'),
  ('shellexperiencehost.exe', 'desktop'),
  ('applicationframehost.exe', 'desktop'),
  ('startmenuexperiencehost.exe', 'desktop'),
  ('textinputhost.exe', 'desktop'),
  ('systemsettings.exe', 'desktop'),
  ('lockapp.exe', 'desktop'),
  ('dwm.exe', 'desktop'),
  ('sihost.exe', 'desktop'),
  ('taskmgr.exe', 'desktop'),
  ('gamebar.exe', 'desktop'),
  ('gamebarftserver.exe', 'desktop'),
  ('chrome.exe', 'browser'),
  ('msedge.exe', 'browser'),
  ('firefox.exe', 'browser'),
  ('brave.exe', 'browser'),
  ('opera.exe', 'browser'),
  ('discord.exe', 'chat'),
  ('discordptb.exe', 'chat'),
  ('discordcanary.exe', 'chat'),
  ('spotify.exe', 'media'),
  ('steam.exe', 'launcher'),
  ('steamwebhelper.exe', 'launcher'),
  ('epicgameslauncher.exe', 'launcher'),
  ('epicwebhelper.exe', 'launcher'),
  ('battle.net.exe', 'launcher'),
  ('riotclientservices.exe', 'launcher'),
  ('riotclientux.exe', 'launcher'),
  ('riotclientuxrender.exe', 'launcher'),
  ('galaxyclient.exe', 'launcher'),
  ('upc.exe', 'launcher'),
  ('eadesktop.exe', 'launcher'),
  ('origin.exe', 'launcher')
on conflict (process_name) do nothing;

alter table public.game_matches enable row level security;
alter table public.game_match_confirmations enable row level security;
alter table public.game_import_state enable row level security;

revoke all on table public.game_matches from public, anon, authenticated;
revoke all on table public.game_match_confirmations from public, anon, authenticated;
revoke all on table public.game_import_state from public, anon, authenticated;

drop policy if exists game_matches_deny on public.game_matches;
drop policy if exists game_match_confirmations_deny on public.game_match_confirmations;
drop policy if exists game_import_state_deny on public.game_import_state;

create policy game_matches_deny on public.game_matches
  for all to anon, authenticated using (false) with check (false);
create policy game_match_confirmations_deny on public.game_match_confirmations
  for all to anon, authenticated using (false) with check (false);
create policy game_import_state_deny on public.game_import_state
  for all to anon, authenticated using (false) with check (false);

grant select, insert, update, delete on table public.game_matches to service_role;
grant select, insert, update, delete on table public.game_match_confirmations to service_role;
grant select, insert, update, delete on table public.game_import_state to service_role;

-- Public pages only list confirmed games. The worker reads pending rows with the service role.
drop policy if exists games_read on public.games;
create policy games_read on public.games
  for select using (status = 'confirmed');
