-- Foundational schema for Project Replay.
-- Social tables are intentionally omitted in Phase 1.

create extension if not exists pgcrypto;

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  storage_limit_bytes bigint not null,
  max_clip_duration_ms integer,
  max_upload_quality text,
  created_at timestamptz not null default now()
);

insert into public.plans (slug, storage_limit_bytes, max_clip_duration_ms, max_upload_quality)
values
  ('free', 5368709120, 300000, '1080p'),
  ('pro', 107374182400, 1800000, 'original'),
  ('pro_plus', 536870912000, 3600000, 'original');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$'),
  username_normalized text generated always as (lower(username)) stored,
  display_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_verified boolean not null default false,
  is_private boolean not null default false,
  followers_count integer not null default 0,
  following_count integer not null default 0,
  clip_count integer not null default 0,
  unique (username_normalized)
);

create table public.user_storage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id uuid not null references public.plans (id),
  storage_used_bytes bigint not null default 0 check (storage_used_bytes >= 0),
  storage_limit_bytes bigint not null check (storage_limit_bytes >= 0),
  updated_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  publisher text,
  cover_url text,
  icon_url text,
  process_names text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index games_process_names_gin on public.games using gin (process_names);

insert into public.games (slug, name, publisher, process_names)
values
  ('fortnite', 'Fortnite', 'Epic Games', array['FortniteClient-Win64-Shipping.exe']),
  ('valorant', 'Valorant', 'Riot Games', array['VALORANT-Win64-Shipping.exe']),
  ('counter-strike-2', 'Counter-Strike 2', 'Valve', array['cs2.exe']);

create table public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid references public.games (id),
  title text,
  description text,
  slug text not null unique,
  storage_key text,
  thumbnail_key text,
  duration_ms integer,
  width integer,
  height integer,
  fps integer,
  codec text,
  file_size_bytes bigint,
  visibility text not null default 'unlisted' check (visibility in ('public', 'unlisted', 'private')),
  status text not null default 'uploading' check (status in ('uploading', 'processing', 'ready', 'failed', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  view_count integer not null default 0,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  share_count integer not null default 0,
  download_count integer not null default 0
);

create index clips_user_created_idx on public.clips (user_id, created_at desc);
create index clips_game_created_idx on public.clips (game_id, created_at desc);
create index clips_status_idx on public.clips (status);
-- Explore/public listings must never include unlisted or private clips.
create index clips_public_published_idx
  on public.clips (published_at desc)
  where visibility = 'public' and status = 'ready';

create table public.upload_sessions (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_key text not null,
  multipart_upload_id text,
  expected_size_bytes bigint,
  declared_content_type text,
  status text not null default 'preparing' check (status in ('preparing', 'uploading', 'completed', 'aborted', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index upload_sessions_expires_idx on public.upload_sessions (expires_at);
create index upload_sessions_user_idx on public.upload_sessions (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

create trigger clips_updated_at before update on public.clips
for each row execute function public.set_updated_at();

create trigger user_storage_updated_at before update on public.user_storage
for each row execute function public.set_updated_at();

create trigger upload_sessions_updated_at before update on public.upload_sessions
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  free_plan public.plans%rowtype;
begin
  select * into strict free_plan from public.plans where slug = 'free';
  insert into public.profiles (id) values (new.id);
  insert into public.user_storage (user_id, plan_id, storage_used_bytes, storage_limit_bytes)
  values (new.id, free_plan.id, 0, free_plan.storage_limit_bytes);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.user_storage enable row level security;
alter table public.games enable row level security;
alter table public.clips enable row level security;
alter table public.upload_sessions enable row level security;

create policy plans_read on public.plans for select using (true);
create policy games_read on public.games for select using (true);

create policy profiles_select on public.profiles
  for select using (is_private = false or id = auth.uid());

create policy profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy user_storage_select on public.user_storage
  for select using (user_id = auth.uid());

-- Writes to user_storage are service-role only (RLS default deny).

create policy clips_owner_all on public.clips
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Unlisted clips are intentionally excluded from PostgREST listing.
create policy clips_public_select on public.clips
  for select using (visibility = 'public' and status = 'ready');

create policy upload_sessions_owner_select on public.upload_sessions
  for select using (user_id = auth.uid());

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;

revoke all on table public.plans from anon, authenticated;
grant select on table public.plans to anon, authenticated;

revoke all on table public.games from anon, authenticated;
grant select on table public.games to anon, authenticated;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to anon, authenticated;
grant update on table public.profiles to authenticated;

revoke all on table public.user_storage from anon, authenticated;
grant select on table public.user_storage to authenticated;

revoke all on table public.clips from anon, authenticated;
grant select on table public.clips to anon, authenticated;
grant insert, update, delete on table public.clips to authenticated;

revoke all on table public.upload_sessions from anon, authenticated;
grant select on table public.upload_sessions to authenticated;
