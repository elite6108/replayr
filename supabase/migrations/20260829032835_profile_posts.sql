-- Profile text posts with optional public clip attach.
-- Writes and reads go through the Worker (service role). Clients have no grants.

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  clip_id uuid null references public.clips (id) on delete set null,
  created_at timestamptz not null default now()
);

create index posts_user_created_idx on public.posts (user_id, created_at desc);

alter table public.posts enable row level security;

revoke all on table public.posts from public, anon, authenticated;
grant all on table public.posts to service_role;

drop policy if exists posts_no_client on public.posts;
create policy posts_no_client on public.posts
  for all to anon, authenticated
  using (false) with check (false);
