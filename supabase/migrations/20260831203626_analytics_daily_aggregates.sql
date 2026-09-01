-- Phase B daily aggregates. DB-derived metrics use this database's configured
-- analytics environment (production on the live project). Do not infer environment
-- from user-controlled Auth metadata.

alter table public.app_settings
  add column if not exists analytics_environment text not null default 'production';

alter table public.app_settings
  drop constraint if exists app_settings_analytics_environment_check;

alter table public.app_settings
  add constraint app_settings_analytics_environment_check
  check (analytics_environment in ('production', 'development'));

create or replace function public.analytics_environment()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('replayr.analytics_environment', true), ''),
    (select analytics_environment from public.app_settings where id = 1),
    'production'
  );
$$;

revoke all on function public.analytics_environment() from public, anon, authenticated;
grant execute on function public.analytics_environment() to service_role;
grant execute on function public.analytics_environment() to supabase_auth_admin;

create or replace function public.emit_signup_analytics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  env text;
begin
  begin
    env := public.analytics_environment();
    if env not in ('production', 'development') then
      env := 'production';
    end if;
    insert into public.analytics_events (
      idempotency_key,
      user_id,
      event_name,
      event_version,
      platform,
      environment,
      properties,
      occurred_at
    ) values (
      'auth.signup_completed:' || new.id::text,
      new.id,
      'auth.signup_completed',
      1,
      'server',
      env,
      '{}'::jsonb,
      coalesce(new.created_at, now())
    )
    on conflict (idempotency_key) do nothing;
  exception
    when others then
      null;
  end;
  return new;
end;
$$;

create table if not exists public.analytics_daily (
  day date not null,
  environment text not null check (environment in ('production', 'development')),
  new_users bigint not null default 0,
  signups bigint not null default 0,
  active_users bigint,
  activated_users bigint,
  cloud_activated_users bigint not null default 0,
  first_clip_activations bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment)
);

create table if not exists public.analytics_downloads_daily (
  day date not null,
  environment text not null check (environment in ('production', 'development')),
  app_download_clicks bigint,
  installer_downloads bigint,
  clip_downloads_authenticated bigint,
  clip_downloads_public bigint,
  folder_public_downloads bigint,
  media_downloads_total bigint,
  unique_authenticated_downloaders bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment)
);

create table if not exists public.analytics_clips_daily (
  day date not null,
  environment text not null check (environment in ('production', 'development')),
  cloud_upload_started bigint,
  cloud_upload_completed bigint not null default 0,
  cloud_upload_failed bigint not null default 0,
  cloud_upload_expired_aborted bigint not null default 0,
  ready_cloud_clips_created bigint not null default 0,
  cloud_bytes_uploaded bigint not null default 0,
  cloud_clip_deletions bigint,
  public_clip_views bigint not null default 0,
  unique_cloud_uploaders bigint,
  clips_saved bigint,
  clip_save_failed bigint,
  clips_shared bigint,
  clips_rendered bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment)
);

create table if not exists public.analytics_storage_daily (
  day date not null,
  environment text not null check (environment in ('production', 'development')),
  total_storage_bytes_end_of_day bigint,
  storage_bytes_added bigint,
  storage_bytes_deleted bigint,
  net_storage_change_bytes bigint,
  ready_cloud_clip_count_end_of_day bigint,
  average_ready_clip_size_bytes bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment)
);

create table if not exists public.analytics_subscription_daily (
  day date not null,
  environment text not null check (environment in ('production', 'development')),
  active_paid_subscribers_end_of_day bigint,
  new_paid_subscribers bigint,
  cancelled_subscriptions bigint,
  expired_subscriptions bigint,
  reactivated_subscriptions bigint,
  active_grants bigint,
  estimated_mrr_cents bigint,
  mrr_is_estimate boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (day, environment)
);

create table if not exists public.analytics_metric_catalog (
  metric_key text primary key,
  availability text not null check (
    availability in ('AVAILABLE', 'PROXY', 'INCOMPLETE', 'NOT_INSTRUMENTED', 'AVAILABLE_ESTIMATE')
  ),
  notes text not null
);

-- Primary key (day, environment) is the range-query index. Do not add duplicates.

alter table public.analytics_daily enable row level security;
alter table public.analytics_downloads_daily enable row level security;
alter table public.analytics_clips_daily enable row level security;
alter table public.analytics_storage_daily enable row level security;
alter table public.analytics_subscription_daily enable row level security;
alter table public.analytics_metric_catalog enable row level security;
alter table public.analytics_daily force row level security;
alter table public.analytics_downloads_daily force row level security;
alter table public.analytics_clips_daily force row level security;
alter table public.analytics_storage_daily force row level security;
alter table public.analytics_subscription_daily force row level security;

revoke all on table public.analytics_daily from public, anon, authenticated;
revoke all on table public.analytics_downloads_daily from public, anon, authenticated;
revoke all on table public.analytics_clips_daily from public, anon, authenticated;
revoke all on table public.analytics_storage_daily from public, anon, authenticated;
revoke all on table public.analytics_subscription_daily from public, anon, authenticated;
revoke all on table public.analytics_metric_catalog from public, anon, authenticated;

grant select, insert, update, delete on table public.analytics_daily to service_role;
grant select, insert, update, delete on table public.analytics_downloads_daily to service_role;
grant select, insert, update, delete on table public.analytics_clips_daily to service_role;
grant select, insert, update, delete on table public.analytics_storage_daily to service_role;
grant select, insert, update, delete on table public.analytics_subscription_daily to service_role;
grant select, insert, update, delete on table public.analytics_metric_catalog to service_role;

insert into public.analytics_metric_catalog (metric_key, availability, notes) values
  ('new_users', 'AVAILABLE', 'auth.users.created_at in the UTC day. Present accounts only; Auth delete removes the row.'),
  ('signups', 'AVAILABLE', 'auth.signup_completed events for that environment.'),
  ('active_users', 'NOT_INSTRUMENTED', 'True DAU needs qualifying client activity events. Not last_sign_in_at.'),
  ('activated_users', 'INCOMPLETE', 'True activation is first clip.saved or first ready cloud clip. clip.saved is not live.'),
  ('cloud_activated_users', 'PROXY', 'First ready cloud clip only. Do not label as full Activated.'),
  ('first_clip_activations', 'INCOMPLETE', 'Requires clip.saved.'),
  ('app_download_clicks', 'NOT_INSTRUMENTED', 'Needs app.download_clicked on marketing download buttons.'),
  ('installer_downloads', 'NOT_INSTRUMENTED', 'Needs Worker GET /releases/Replayr.exe|.dmg hook. Not the same as a button click.'),
  ('clip_downloads_authenticated', 'NOT_INSTRUMENTED', 'Needs clip.downloaded on successful /v1/clips/:slug/download for signed-in viewers.'),
  ('clip_downloads_public', 'NOT_INSTRUMENTED', 'Needs clip.public_downloaded for anonymous clip downloads.'),
  ('folder_public_downloads', 'NOT_INSTRUMENTED', 'Needs folder.public_downloaded on public folder download.'),
  ('media_downloads_total', 'NOT_INSTRUMENTED', 'Sum of media download events only. Never include app downloads.'),
  ('cloud_upload_started', 'AVAILABLE', 'upload_sessions created that UTC day.'),
  ('cloud_upload_completed', 'AVAILABLE', 'upload_sessions.status=completed by updated_at that UTC day.'),
  ('cloud_upload_failed', 'AVAILABLE', 'Clips marked failed that day (size mismatch and expired via failClip). Retryable multipart 502 is not included.'),
  ('cloud_upload_expired_aborted', 'INCOMPLETE', 'Leftover upload_sessions aborted/expired rows. Expired sessions are deleted after failClip, so those terminals live in cloud_upload_failed.'),
  ('upload_success_rate', 'AVAILABLE', 'completed / (completed + failed). Failed clips already include expired/aborted terminals. Do not add leftover aborted session rows or retryable 502s.'),
  ('ready_cloud_clips_created', 'AVAILABLE', 'clips.status=ready created that UTC day.'),
  ('cloud_bytes_uploaded', 'AVAILABLE', 'Original MP4 file_size_bytes of ready clips created that day.'),
  ('public_clip_views', 'AVAILABLE', 'sum(clip_daily_views.count) for that UTC day.'),
  ('clips_saved', 'NOT_INSTRUMENTED', 'Local clip.saved is not live.'),
  ('total_storage_bytes_end_of_day', 'AVAILABLE', 'Current UTC day only: sum(user_storage.storage_used_bytes). Original cloud media quota only.'),
  ('storage_bytes_added', 'AVAILABLE', 'Ready clip file_size_bytes created that day. Original MP4 only.'),
  ('storage_bytes_deleted', 'INCOMPLETE', 'Soft-deleted clips by updated_at when present. Not a full deletion ledger.'),
  ('net_storage_change_bytes', 'INCOMPLETE', 'Left null. Do not treat added minus deleted as a reconciled ledger.'),
  ('active_paid_subscribers_end_of_day', 'AVAILABLE', 'Current UTC day snapshot: billing_subscriptions status active|trialing|past_due.'),
  ('new_paid_subscribers', 'INCOMPLETE', 'stripe_events customer.subscription.created when present; no created_at on billing_subscriptions.'),
  ('estimated_mrr_cents', 'AVAILABLE_ESTIMATE', 'Hardcoded $4.99 / $3.99 estimate from price ids. mrr_is_estimate is always true.')
on conflict (metric_key) do update
  set availability = excluded.availability,
      notes = excluded.notes;

create or replace function public.rollup_analytics_days(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d date;
  db_env text := public.analytics_environment();
  ev text;
  n int := 0;
  day_start timestamptz;
  day_end timestamptz;
  is_today boolean;
  v_new_users bigint;
  v_signups bigint;
  v_cloud_activated bigint;
  v_started bigint;
  v_completed bigint;
  v_failed bigint;
  v_expired bigint;
  v_ready bigint;
  v_bytes bigint;
  v_deleted bigint;
  v_views bigint;
  v_uploaders bigint;
  v_storage_total bigint;
  v_storage_added bigint;
  v_storage_deleted bigint;
  v_ready_eod bigint;
  v_avg_size bigint;
  v_active_paid bigint;
  v_new_paid bigint;
  v_cancelled bigint;
  v_grants bigint;
  v_mrr bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'rollup range must be [from, to) with to > from';
  end if;
  if p_to - p_from > 366 then
    raise exception 'rollup range cannot exceed 366 days';
  end if;
  if db_env not in ('production', 'development') then
    db_env := 'production';
  end if;

  d := p_from;
  while d < p_to loop
    day_start := (d::timestamp at time zone 'utc');
    day_end := ((d + 1)::timestamp at time zone 'utc');
    is_today := d = (timezone('utc', now()))::date;

    foreach ev in array array['production', 'development'] loop
      select count(*) into v_signups
        from public.analytics_events
       where event_name = 'auth.signup_completed'
         and environment = ev
         and occurred_at >= day_start
         and occurred_at < day_end;

      if ev = db_env then
        select count(*) into v_new_users
          from auth.users
         where created_at >= day_start
           and created_at < day_end;

        select count(*) into v_cloud_activated
          from (
            select user_id, min(created_at) as first_ready
              from public.clips
             where status = 'ready'
             group by user_id
          ) firsts
         where first_ready >= day_start
           and first_ready < day_end;

        select count(*) into v_started
          from public.upload_sessions
         where created_at >= day_start
           and created_at < day_end;

        select count(*) into v_completed
          from public.upload_sessions
         where status = 'completed'
           and updated_at >= day_start
           and updated_at < day_end;

        select count(*) into v_failed
          from public.clips
         where status = 'failed'
           and updated_at >= day_start
           and updated_at < day_end;

        select count(*) into v_expired
          from public.upload_sessions
         where status in ('aborted', 'expired')
           and updated_at >= day_start
           and updated_at < day_end;

        select count(*) into v_ready
          from public.clips
         where status = 'ready'
           and created_at >= day_start
           and created_at < day_end;

        select coalesce(sum(file_size_bytes), 0) into v_bytes
          from public.clips
         where status = 'ready'
           and created_at >= day_start
           and created_at < day_end;

        select count(*) into v_deleted
          from public.clips
         where status = 'deleted'
           and updated_at >= day_start
           and updated_at < day_end;

        select coalesce(sum(count), 0) into v_views
          from public.clip_daily_views
         where day = d;

        select count(distinct user_id) into v_uploaders
          from public.clips
         where status = 'ready'
           and created_at >= day_start
           and created_at < day_end;

        select coalesce(sum(file_size_bytes), 0) into v_storage_added
          from public.clips
         where status = 'ready'
           and created_at >= day_start
           and created_at < day_end;

        select coalesce(sum(file_size_bytes), 0) into v_storage_deleted
          from public.clips
         where status = 'deleted'
           and updated_at >= day_start
           and updated_at < day_end
           and file_size_bytes is not null;

        if is_today then
          select coalesce(sum(storage_used_bytes), 0) into v_storage_total
            from public.user_storage;
          select count(*) into v_ready_eod
            from public.clips
           where status = 'ready';
          select case when count(*) = 0 then null else (sum(file_size_bytes) / count(*))::bigint end
            into v_avg_size
            from public.clips
           where status = 'ready'
             and file_size_bytes is not null
             and file_size_bytes > 0;

          select count(*) into v_active_paid
            from public.billing_subscriptions
           where status in ('active', 'trialing', 'past_due');

          select count(*) into v_grants
            from public.billing_grants
           where revoked_at is null
             and (expires_at is null or expires_at >= day_end);

          select coalesce(sum(
            case
              when stripe_price_id is not null and stripe_price_id like '%year%' then 399
              else 499
            end
          ), 0) into v_mrr
            from public.billing_subscriptions
           where status in ('active', 'trialing', 'past_due');
        else
          v_storage_total := null;
          v_ready_eod := null;
          v_avg_size := null;
          v_active_paid := null;
          v_grants := null;
          v_mrr := null;
        end if;

        select count(*) into v_new_paid
          from public.stripe_events
         where type = 'customer.subscription.created'
           and created_at >= day_start
           and created_at < day_end;

        select count(*) into v_cancelled
          from public.stripe_events
         where type = 'customer.subscription.deleted'
           and created_at >= day_start
           and created_at < day_end;
      else
        v_new_users := v_signups;
        v_cloud_activated := 0;
        v_started := null;
        v_completed := (
          select count(*) from public.analytics_events
           where event_name = 'clip.upload_completed'
             and environment = ev
             and occurred_at >= day_start
             and occurred_at < day_end
        );
        v_failed := (
          select count(*) from public.analytics_events
           where event_name = 'clip.upload_failed'
             and environment = ev
             and occurred_at >= day_start
             and occurred_at < day_end
        );
        v_expired := 0;
        v_ready := v_completed;
        v_bytes := 0;
        v_deleted := null;
        v_views := 0;
        v_uploaders := null;
        v_storage_added := null;
        v_storage_deleted := null;
        v_storage_total := null;
        v_ready_eod := null;
        v_avg_size := null;
        v_active_paid := null;
        v_new_paid := null;
        v_cancelled := null;
        v_grants := null;
        v_mrr := null;
      end if;

      insert into public.analytics_daily (
        day, environment, new_users, signups, active_users, activated_users,
        cloud_activated_users, first_clip_activations, updated_at
      ) values (
        d, ev, coalesce(v_new_users, 0), coalesce(v_signups, 0), null, null,
        coalesce(v_cloud_activated, 0), null, now()
      )
      on conflict (day, environment) do update set
        new_users = excluded.new_users,
        signups = excluded.signups,
        active_users = excluded.active_users,
        activated_users = excluded.activated_users,
        cloud_activated_users = excluded.cloud_activated_users,
        first_clip_activations = excluded.first_clip_activations,
        updated_at = now();

      insert into public.analytics_downloads_daily (
        day, environment, app_download_clicks, installer_downloads,
        clip_downloads_authenticated, clip_downloads_public, folder_public_downloads,
        media_downloads_total, unique_authenticated_downloaders, updated_at
      ) values (
        d, ev, null, null, null, null, null, null, null, now()
      )
      on conflict (day, environment) do update set
        updated_at = now();

      insert into public.analytics_clips_daily (
        day, environment, cloud_upload_started, cloud_upload_completed, cloud_upload_failed,
        cloud_upload_expired_aborted, ready_cloud_clips_created, cloud_bytes_uploaded,
        cloud_clip_deletions, public_clip_views, unique_cloud_uploaders,
        clips_saved, clip_save_failed, clips_shared, clips_rendered, updated_at
      ) values (
        d, ev, v_started, coalesce(v_completed, 0), coalesce(v_failed, 0),
        coalesce(v_expired, 0), coalesce(v_ready, 0), coalesce(v_bytes, 0),
        v_deleted, coalesce(v_views, 0), v_uploaders,
        null, null, null, null, now()
      )
      on conflict (day, environment) do update set
        cloud_upload_started = excluded.cloud_upload_started,
        cloud_upload_completed = excluded.cloud_upload_completed,
        cloud_upload_failed = excluded.cloud_upload_failed,
        cloud_upload_expired_aborted = excluded.cloud_upload_expired_aborted,
        ready_cloud_clips_created = excluded.ready_cloud_clips_created,
        cloud_bytes_uploaded = excluded.cloud_bytes_uploaded,
        cloud_clip_deletions = excluded.cloud_clip_deletions,
        public_clip_views = excluded.public_clip_views,
        unique_cloud_uploaders = excluded.unique_cloud_uploaders,
        clips_saved = coalesce(excluded.clips_saved, public.analytics_clips_daily.clips_saved),
        clip_save_failed = coalesce(excluded.clip_save_failed, public.analytics_clips_daily.clip_save_failed),
        clips_shared = coalesce(excluded.clips_shared, public.analytics_clips_daily.clips_shared),
        clips_rendered = coalesce(excluded.clips_rendered, public.analytics_clips_daily.clips_rendered),
        updated_at = now();

      insert into public.analytics_storage_daily (
        day, environment, total_storage_bytes_end_of_day, storage_bytes_added,
        storage_bytes_deleted, net_storage_change_bytes, ready_cloud_clip_count_end_of_day,
        average_ready_clip_size_bytes, updated_at
      ) values (
        d, ev, v_storage_total, v_storage_added,
        case when ev = db_env then v_storage_deleted else null end,
        null,
        v_ready_eod, v_avg_size, now()
      )
      on conflict (day, environment) do update set
        total_storage_bytes_end_of_day = excluded.total_storage_bytes_end_of_day,
        storage_bytes_added = excluded.storage_bytes_added,
        storage_bytes_deleted = excluded.storage_bytes_deleted,
        net_storage_change_bytes = excluded.net_storage_change_bytes,
        ready_cloud_clip_count_end_of_day = excluded.ready_cloud_clip_count_end_of_day,
        average_ready_clip_size_bytes = excluded.average_ready_clip_size_bytes,
        updated_at = now();

      insert into public.analytics_subscription_daily (
        day, environment, active_paid_subscribers_end_of_day, new_paid_subscribers,
        cancelled_subscriptions, expired_subscriptions, reactivated_subscriptions,
        active_grants, estimated_mrr_cents, mrr_is_estimate, updated_at
      ) values (
        d, ev, v_active_paid, v_new_paid, v_cancelled, null, null,
        v_grants, v_mrr, true, now()
      )
      on conflict (day, environment) do update set
        active_paid_subscribers_end_of_day = excluded.active_paid_subscribers_end_of_day,
        new_paid_subscribers = excluded.new_paid_subscribers,
        cancelled_subscriptions = excluded.cancelled_subscriptions,
        expired_subscriptions = excluded.expired_subscriptions,
        reactivated_subscriptions = excluded.reactivated_subscriptions,
        active_grants = excluded.active_grants,
        estimated_mrr_cents = excluded.estimated_mrr_cents,
        mrr_is_estimate = true,
        updated_at = now();

      n := n + 1;
    end loop;

    d := d + 1;
  end loop;

  return n;
end;
$$;

revoke all on function public.rollup_analytics_days(date, date) from public, anon, authenticated;
grant execute on function public.rollup_analytics_days(date, date) to service_role;
