alter table public.staff_members
  add column if not exists notify_board_email boolean not null default true;

create table if not exists public.staff_board_email_prefs (
  staff_id uuid not null references public.staff_members (id) on delete cascade,
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  email boolean not null,
  updated_at timestamptz not null default now(),
  primary key (staff_id, board_id)
);

create index if not exists staff_board_email_prefs_board_idx
  on public.staff_board_email_prefs (board_id);

alter table public.staff_board_email_prefs enable row level security;
alter table public.staff_board_email_prefs force row level security;

revoke all on table public.staff_board_email_prefs from public, anon, authenticated;
grant all on table public.staff_board_email_prefs to service_role;

drop policy if exists staff_board_email_prefs_no_client on public.staff_board_email_prefs;
create policy staff_board_email_prefs_no_client on public.staff_board_email_prefs
  for all to anon, authenticated
  using (false) with check (false);
