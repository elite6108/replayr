-- Creator program applications from the public website.
-- One row per signed-in user. Not publicly listable.

create table public.creator_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  channel_url text not null check (char_length(trim(channel_url)) between 8 and 500),
  game text check (game is null or char_length(game) <= 80),
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.creator_applications enable row level security;

create policy creator_applications_owner_select
  on public.creator_applications
  for select
  using (user_id = auth.uid());

create policy creator_applications_owner_insert
  on public.creator_applications
  for insert
  with check (user_id = auth.uid());

revoke all on table public.creator_applications from anon, authenticated;
grant select, insert on table public.creator_applications to authenticated;
