-- Phase C: download event rollup. Days before analytics_downloads_available_from stay NULL.

alter table public.app_settings
  add column if not exists analytics_downloads_available_from date not null default '2026-08-31';

alter table public.analytics_metric_catalog
  add column if not exists available_from date;

update public.app_settings
   set analytics_downloads_available_from = '2026-08-31'
 where id = 1;

insert into public.analytics_metric_catalog (metric_key, availability, notes, available_from) values
  ('app_download_clicks', 'AVAILABLE', 'app.download_clicked on marketing download buttons. Click only, not an installer download.', '2026-08-31'),
  ('installer_downloads', 'AVAILABLE', 'GET 200 full-file responses for /releases/Replayr.exe and Replayr.dmg. Not latest.json, HEAD, or resume Range requests.', '2026-08-31'),
  ('clip_downloads_authenticated', 'AVAILABLE', 'clip.downloaded after a successful authenticated clip file response or branded stream.', '2026-08-31'),
  ('clip_downloads_public', 'AVAILABLE', 'clip.public_downloaded after a successful anonymous clip download.', '2026-08-31'),
  ('folder_public_downloads', 'AVAILABLE', 'folder.public_downloaded after a public folder download URL is issued.', '2026-08-31'),
  ('media_downloads_total', 'AVAILABLE', 'Sum of authenticated clip + public clip + public folder downloads. Never includes app/installer downloads.', '2026-08-31'),
  ('unique_authenticated_downloaders', 'AVAILABLE', 'Distinct user_id on clip.downloaded that UTC day.', '2026-08-31')
on conflict (metric_key) do update
  set availability = excluded.availability,
      notes = excluded.notes,
      available_from = excluded.available_from;

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
  downloads_from date := coalesce(
    (select analytics_downloads_available_from from public.app_settings where id = 1),
    '2026-08-31'::date
  );
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
  v_clicks bigint;
  v_installers bigint;
  v_clip_auth bigint;
  v_clip_pub bigint;
  v_folder_dl bigint;
  v_media bigint;
  v_unique_dl bigint;
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

      if d < downloads_from then
        v_clicks := null;
        v_installers := null;
        v_clip_auth := null;
        v_clip_pub := null;
        v_folder_dl := null;
        v_media := null;
        v_unique_dl := null;
      else
        select count(*) into v_clicks
          from public.analytics_events
         where event_name = 'app.download_clicked'
           and environment = ev
           and occurred_at >= day_start
           and occurred_at < day_end;
        select count(*) into v_installers
          from public.analytics_events
         where event_name = 'app.installer_downloaded'
           and environment = ev
           and occurred_at >= day_start
           and occurred_at < day_end;
        select count(*) into v_clip_auth
          from public.analytics_events
         where event_name = 'clip.downloaded'
           and environment = ev
           and occurred_at >= day_start
           and occurred_at < day_end;
        select count(*) into v_clip_pub
          from public.analytics_events
         where event_name = 'clip.public_downloaded'
           and environment = ev
           and occurred_at >= day_start
           and occurred_at < day_end;
        select count(*) into v_folder_dl
          from public.analytics_events
         where event_name = 'folder.public_downloaded'
           and environment = ev
           and occurred_at >= day_start
           and occurred_at < day_end;
        v_media := coalesce(v_clip_auth, 0) + coalesce(v_clip_pub, 0) + coalesce(v_folder_dl, 0);
        select count(distinct user_id) into v_unique_dl
          from public.analytics_events
         where event_name = 'clip.downloaded'
           and environment = ev
           and user_id is not null
           and occurred_at >= day_start
           and occurred_at < day_end;
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
        d, ev, v_clicks, v_installers, v_clip_auth, v_clip_pub, v_folder_dl, v_media, v_unique_dl, now()
      )
      on conflict (day, environment) do update set
        app_download_clicks = excluded.app_download_clicks,
        installer_downloads = excluded.installer_downloads,
        clip_downloads_authenticated = excluded.clip_downloads_authenticated,
        clip_downloads_public = excluded.clip_downloads_public,
        folder_public_downloads = excluded.folder_public_downloads,
        media_downloads_total = excluded.media_downloads_total,
        unique_authenticated_downloaders = excluded.unique_authenticated_downloaders,
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
