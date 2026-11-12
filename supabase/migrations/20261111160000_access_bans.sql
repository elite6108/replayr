-- Account and IP bans. The worker is the only client. Account bans also
-- set profiles.suspended_at so the existing account gate keeps blocking them.

insert into public.staff_permissions (key, category, label, description, sort) values
  ('users.ban', 'users', 'Ban accounts and IPs', 'Block a Replayr account or a public IP address.', 340)
on conflict (key) do nothing;

insert into public.staff_role_permissions (role_id, permission_key) values
  ('00000000-0000-4000-8000-000000000002', 'users.ban')
on conflict do nothing;

create table public.access_bans (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  subject text not null,
  reason text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references auth.users (id) on delete set null,
  constraint access_bans_kind_chk check (kind in ('account', 'ip')),
  constraint access_bans_subject_chk check (char_length(subject) between 1 and 64),
  constraint access_bans_reason_chk check (char_length(reason) between 1 and 200)
);

create unique index access_bans_active_subject_idx
  on public.access_bans (kind, subject)
  where lifted_at is null;

create index access_bans_active_created_idx
  on public.access_bans (created_at desc)
  where lifted_at is null;

alter table public.access_bans enable row level security;
alter table public.access_bans force row level security;

create policy access_bans_no_client
  on public.access_bans
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.access_bans from public, anon, authenticated;
grant select, insert, update, delete on table public.access_bans to service_role;
