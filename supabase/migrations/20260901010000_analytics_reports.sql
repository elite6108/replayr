-- Phase I: immutable analytics report snapshots. Not scheduled email reports.
-- Observational. Does not change capture, billing, or folder authorization.

create table if not exists public.analytics_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('daily', 'weekly', 'monthly', 'quarterly', 'ytd', 'custom')),
  period_start date not null,
  period_end date not null,
  display_timezone text not null default 'America/New_York',
  title text not null,
  generated_by uuid,
  report_version integer not null default 1,
  metric_dictionary_version integer,
  status text not null check (status in ('ready', 'failed', 'generating')) default 'ready',
  summary_json jsonb not null default '{}'::jsonb,
  metrics_json jsonb not null default '{}'::jsonb,
  availability_json jsonb not null default '{}'::jsonb,
  insights_json jsonb not null default '[]'::jsonb,
  recommendations_json jsonb not null default '[]'::jsonb,
  pdf_object_key text,
  pdf_status text,
  regenerated_from_id uuid references public.analytics_reports(id),
  created_at timestamptz not null default now(),
  check (period_end > period_start)
);

create index if not exists analytics_reports_created_idx on public.analytics_reports (created_at desc, id desc);
create index if not exists analytics_reports_type_idx on public.analytics_reports (report_type, period_start desc);

alter table public.analytics_reports enable row level security;
alter table public.analytics_reports force row level security;
revoke all on table public.analytics_reports from public, anon, authenticated;
grant select, insert on table public.analytics_reports to service_role;
revoke update, delete, truncate on table public.analytics_reports from public, anon, authenticated, service_role;
