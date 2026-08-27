-- Waitlist emails for the public coming-soon page (Worker service-role only).
create table if not exists public.waitlist_emails (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null default 'coming-soon',
  created_at timestamptz not null default now(),
  constraint waitlist_emails_email_key unique (email)
);

create index if not exists waitlist_emails_created_at_idx
  on public.waitlist_emails (created_at desc);

alter table public.waitlist_emails enable row level security;

revoke all on table public.waitlist_emails from public, anon, authenticated;
grant all on table public.waitlist_emails to service_role;
