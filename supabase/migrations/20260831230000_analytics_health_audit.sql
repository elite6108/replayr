-- Phase G/H: product health daily + append-only audit log.
-- Observational. Does not replace error_events or folder_activity.

create table if not exists public.analytics_health_daily (
  day date not null,
  environment text not null,
  platform text not null default '',
  app_version text not null default '',
  clip_save_success bigint not null default 0,
  clip_save_failed bigint not null default 0,
  upload_success bigint not null default 0,
  upload_failed bigint not null default 0,
  render_success bigint not null default 0,
  render_failed bigint not null default 0,
  playback_failed bigint,
  download_failed bigint,
  error_events bigint not null default 0,
  critical_errors bigint not null default 0,
  unique_affected_users bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, environment, platform, app_version)
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  actor_type text not null check (actor_type in ('user', 'admin', 'system')),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  environment text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc, id desc);
create index if not exists audit_log_action_idx on public.audit_log (action, created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_user_id, created_at desc);
create index if not exists audit_log_target_idx on public.audit_log (target_type, target_id);

create or replace function public.rollup_analytics_health_days(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ev text;
  d date;
  days int := 0;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Range must be [from, to) with to after from.';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'Analytics backfill is limited to 366 days.';
  end if;

  foreach ev in array array['production', 'development'] loop
    d := p_from;
    while d < p_to loop
      insert into public.analytics_health_daily (
        day, environment, platform, app_version,
        clip_save_success, clip_save_failed, upload_success, upload_failed,
        render_success, render_failed, playback_failed, download_failed,
        error_events, critical_errors, unique_affected_users, updated_at
      )
      select
        d, ev, '', '',
        count(*) filter (where event_name = 'clip.saved'),
        count(*) filter (where event_name = 'clip.save_failed' and coalesce(properties->>'failure_category', '') <> 'cancelled'),
        count(*) filter (where event_name = 'clip.upload_completed'),
        count(*) filter (where event_name = 'clip.upload_failed'),
        count(*) filter (where event_name = 'clip.rendered'),
        count(*) filter (where event_name = 'clip.render_failed'),
        null, null,
        0, 0, 0, now()
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
      on conflict (day, environment, platform, app_version) do update set
        clip_save_success = excluded.clip_save_success,
        clip_save_failed = excluded.clip_save_failed,
        upload_success = excluded.upload_success,
        upload_failed = excluded.upload_failed,
        render_success = excluded.render_success,
        render_failed = excluded.render_failed,
        playback_failed = excluded.playback_failed,
        download_failed = excluded.download_failed,
        updated_at = now();

      update public.analytics_health_daily h
      set
        error_events = e.errors,
        critical_errors = e.critical,
        unique_affected_users = e.affected,
        updated_at = now()
      from (
        select
          count(*) as errors,
          count(*) filter (where level = 'crash') as critical,
          count(distinct sample_user_id) filter (where sample_user_id is not null) as affected
        from public.error_events
        where last_seen_at >= d and last_seen_at < (d + 1)
          and ev = public.analytics_environment()
      ) e
      where h.day = d and h.environment = ev and h.platform = '' and h.app_version = '';

      insert into public.analytics_health_daily (
        day, environment, platform, app_version,
        clip_save_success, clip_save_failed, upload_success, upload_failed,
        render_success, render_failed, updated_at
      )
      select
        d, ev, coalesce(nullif(platform, ''), 'unknown'), '',
        count(*) filter (where event_name = 'clip.saved'),
        count(*) filter (where event_name = 'clip.save_failed' and coalesce(properties->>'failure_category', '') <> 'cancelled'),
        count(*) filter (where event_name = 'clip.upload_completed'),
        count(*) filter (where event_name = 'clip.upload_failed'),
        count(*) filter (where event_name = 'clip.rendered'),
        count(*) filter (where event_name = 'clip.render_failed'),
        now()
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
        and platform is not null
      group by 3
      on conflict (day, environment, platform, app_version) do update set
        clip_save_success = excluded.clip_save_success,
        clip_save_failed = excluded.clip_save_failed,
        upload_success = excluded.upload_success,
        upload_failed = excluded.upload_failed,
        render_success = excluded.render_success,
        render_failed = excluded.render_failed,
        updated_at = now();

      insert into public.analytics_health_daily (
        day, environment, platform, app_version,
        clip_save_success, clip_save_failed, upload_success, upload_failed,
        render_success, render_failed, updated_at
      )
      select
        d, ev, '', left(coalesce(app_version, ''), 40),
        count(*) filter (where event_name = 'clip.saved'),
        count(*) filter (where event_name = 'clip.save_failed' and coalesce(properties->>'failure_category', '') <> 'cancelled'),
        count(*) filter (where event_name = 'clip.upload_completed'),
        count(*) filter (where event_name = 'clip.upload_failed'),
        count(*) filter (where event_name = 'clip.rendered'),
        count(*) filter (where event_name = 'clip.render_failed'),
        now()
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
        and app_version is not null
        and app_version <> ''
      group by 4
      on conflict (day, environment, platform, app_version) do update set
        clip_save_success = excluded.clip_save_success,
        clip_save_failed = excluded.clip_save_failed,
        upload_success = excluded.upload_success,
        upload_failed = excluded.upload_failed,
        render_success = excluded.render_success,
        render_failed = excluded.render_failed,
        updated_at = now();

      days := days + 1;
      d := d + 1;
    end loop;
  end loop;
  return days;
end;
$$;

alter table public.analytics_health_daily enable row level security;
alter table public.audit_log enable row level security;
alter table public.analytics_health_daily force row level security;
alter table public.audit_log force row level security;
revoke all on table public.analytics_health_daily from public, anon, authenticated;
revoke all on table public.audit_log from public, anon, authenticated;
grant select, insert, update, delete on table public.analytics_health_daily to service_role;
grant insert, select on table public.audit_log to service_role;
revoke update, delete on table public.audit_log from public, anon, authenticated, service_role;
revoke all on function public.rollup_analytics_health_days(date, date) from public, anon, authenticated;
grant execute on function public.rollup_analytics_health_days(date, date) to service_role;

insert into public.analytics_metric_catalog (metric_key, availability, notes, available_from) values
  ('clip_save_success_rate', 'INCOMPLETE', 'clip.saved / (clip.saved + clip.save_failed excluding cancelled). Desktop instrumentation from 2026-08-31.', '2026-08-31'),
  ('upload_success_rate', 'AVAILABLE', 'Terminal clip.upload_completed / (completed + failed). Retryable 502 excluded at ingest.', null),
  ('render_success_rate', 'INCOMPLETE', 'clip.rendered / (rendered + clip.render_failed). Failures instrumented from 2026-08-31. Cancellations omitted.', '2026-08-31'),
  ('error_events', 'AVAILABLE', 'error_events groups with last_seen_at in the UTC day. Not a replacement for the Errors admin.', null),
  ('critical_errors', 'AVAILABLE', 'error_events.level = crash.', null),
  ('unique_affected_users', 'AVAILABLE', 'Distinct sample_user_id on error groups last seen that day. One sample per fingerprint.', null),
  ('health_version_comparison', 'INCOMPLETE', 'Requires app_version on desktop events. Sample >= 100 to flag a regression.', '2026-08-31')
on conflict (metric_key) do update set
  availability = excluded.availability,
  notes = excluded.notes,
  available_from = excluded.available_from;
