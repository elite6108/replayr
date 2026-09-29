alter table public.staff_members
  add column if not exists notify_board_push boolean not null default true;

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  expo_push_token text not null,
  platform text not null default 'ios',
  updated_at timestamptz not null default now(),
  unique (expo_push_token)
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;
alter table public.push_tokens force row level security;

revoke all on table public.push_tokens from public, anon;
grant select, insert, update, delete on table public.push_tokens to authenticated;
grant all on table public.push_tokens to service_role;

drop policy if exists push_tokens_select_own on public.push_tokens;
create policy push_tokens_select_own on public.push_tokens
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists push_tokens_insert_own on public.push_tokens;
create policy push_tokens_insert_own on public.push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists push_tokens_update_own on public.push_tokens;
create policy push_tokens_update_own on public.push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists push_tokens_delete_own on public.push_tokens;
create policy push_tokens_delete_own on public.push_tokens
  for delete to authenticated
  using (user_id = auth.uid());
