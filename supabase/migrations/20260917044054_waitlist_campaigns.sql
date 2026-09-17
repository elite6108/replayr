-- Waitlist confirmation/unsubscribe columns, campaign send queue, and operator permissions.

alter table public.waitlist_emails
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid(),
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists confirmation_sent_at timestamptz;

create unique index if not exists waitlist_emails_unsubscribe_token_idx
  on public.waitlist_emails (unsubscribe_token);

create table if not exists public.waitlist_email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.waitlist_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body text not null,
  talking_points text,
  include_announcements boolean not null default false,
  audience text not null check (audience in ('all', 'selected')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'partial', 'failed')),
  created_by uuid,
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.waitlist_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.waitlist_campaigns (id) on delete cascade,
  waitlist_id uuid not null references public.waitlist_emails (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  provider_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (campaign_id, waitlist_id)
);

create index if not exists waitlist_campaign_recipients_pending_idx
  on public.waitlist_campaign_recipients (status, created_at)
  where status = 'pending';

alter table public.waitlist_email_templates enable row level security;
alter table public.waitlist_campaigns enable row level security;
alter table public.waitlist_campaign_recipients enable row level security;
alter table public.waitlist_email_templates force row level security;
alter table public.waitlist_campaigns force row level security;
alter table public.waitlist_campaign_recipients force row level security;

revoke all on table public.waitlist_email_templates from public, anon, authenticated;
revoke all on table public.waitlist_campaigns from public, anon, authenticated;
revoke all on table public.waitlist_campaign_recipients from public, anon, authenticated;
grant all on table public.waitlist_email_templates to service_role;
grant all on table public.waitlist_campaigns to service_role;
grant all on table public.waitlist_campaign_recipients to service_role;

drop policy if exists waitlist_email_templates_no_client on public.waitlist_email_templates;
create policy waitlist_email_templates_no_client on public.waitlist_email_templates
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists waitlist_campaigns_no_client on public.waitlist_campaigns;
create policy waitlist_campaigns_no_client on public.waitlist_campaigns
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists waitlist_campaign_recipients_no_client on public.waitlist_campaign_recipients;
create policy waitlist_campaign_recipients_no_client on public.waitlist_campaign_recipients
  for all to anon, authenticated
  using (false) with check (false);

insert into public.staff_permissions (key, category, label, description, sort) values
  ('waitlist.view', 'people', 'View waitlist', 'List waitlist emails and campaign history.', 340),
  ('waitlist.send', 'people', 'Send waitlist email', 'Send confirmation-style campaigns to the waitlist.', 350),
  ('waitlist.templates.manage', 'people', 'Manage waitlist templates', 'Save and edit reusable waitlist email templates.', 360)
on conflict (key) do nothing;

insert into public.staff_role_permissions (role_id, permission_key)
select '00000000-0000-4000-8000-000000000002', key
from public.staff_permissions
where key in ('waitlist.view', 'waitlist.send', 'waitlist.templates.manage')
on conflict do nothing;
