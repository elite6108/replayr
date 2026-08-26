-- Operator-controlled announcement banners and popups for desktop, web, and mobile.

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default false,
  title text not null,
  body text,
  image_url text,
  image_key text,
  cta_label text,
  cta_url text,
  placement text not null default 'modal'
    check (placement in ('banner', 'modal')),
  show_desktop boolean not null default true,
  show_web boolean not null default true,
  show_mobile boolean not null default true,
  audience text not null default 'all'
    check (audience in ('all', 'signed_out', 'signed_in', 'free', 'premium')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  frequency text not null default 'once'
    check (frequency in ('once', 'every_session', 'interval')),
  interval_hours integer not null default 24 check (interval_hours >= 1 and interval_hours <= 24 * 30),
  max_impressions integer check (max_impressions is null or max_impressions >= 1),
  dismiss_behavior text not null default 'forever'
    check (dismiss_behavior in ('forever', 'snooze')),
  dismissible boolean not null default true,
  priority integer not null default 0,
  content_revision integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint announcements_window_chk check (ends_at is null or ends_at > starts_at)
);

create index announcements_active_idx
  on public.announcements (enabled, starts_at, ends_at, priority desc)
  where enabled = true;

alter table public.announcements enable row level security;

revoke all on table public.announcements from public, anon, authenticated;
grant select, insert, update, delete on table public.announcements to service_role;
