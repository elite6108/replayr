alter table public.staff_members
  add column if not exists notify_own_board_email boolean not null default false;
