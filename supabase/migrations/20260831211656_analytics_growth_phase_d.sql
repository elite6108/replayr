-- Phase D: user-day activity, milestones, first-party acquisition.
-- Observational only. Does not invent pre-instrumentation product activity.

alter table public.app_settings
  add column if not exists analytics_activity_available_from date not null default date '2026-08-31';

update public.app_settings
   set analytics_activity_available_from = date '2026-08-31'
 where id = 1;

create or replace function public.analytics_earliest(a timestamptz, b timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case
    when a is null then b
    when b is null then a
    when a <= b then a
    else b
  end;
$$;

create table if not exists public.analytics_user_daily_activity (
  day date not null,
  user_id uuid not null,
  environment text not null,
  active boolean not null default true,
  app_opened boolean not null default false,
  clip_saved boolean not null default false,
  clip_uploaded boolean not null default false,
  editor_used boolean not null default false,
  rendered boolean not null default false,
  folder_used boolean not null default false,
  event_count integer not null default 0,
  clip_save_count integer not null default 0,
  first_event_at timestamptz,
  last_event_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (day, user_id, environment),
  constraint analytics_user_daily_activity_env_check
    check (environment in ('production', 'development'))
);

create index if not exists analytics_user_daily_activity_user_day_idx
  on public.analytics_user_daily_activity (user_id, day desc);

create index if not exists analytics_user_daily_activity_env_day_idx
  on public.analytics_user_daily_activity (environment, day);

create table if not exists public.analytics_user_milestones (
  user_id uuid not null,
  environment text not null,
  signup_at timestamptz,
  first_app_open_at timestamptz,
  first_clip_saved_at timestamptz,
  first_cloud_upload_at timestamptz,
  activated_at timestamptz,
  activation_source text,
  activation_quality text,
  first_editor_open_at timestamptz,
  first_render_at timestamptz,
  first_share_at timestamptz,
  first_folder_at timestamptz,
  first_subscription_at timestamptz,
  last_active_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, environment),
  constraint analytics_user_milestones_env_check
    check (environment in ('production', 'development')),
  constraint analytics_user_milestones_source_check
    check (activation_source is null or activation_source in ('local_clip', 'cloud_clip')),
  constraint analytics_user_milestones_quality_check
    check (activation_quality is null or activation_quality in ('exact', 'cloud_proxy'))
);

create index if not exists analytics_user_milestones_signup_idx
  on public.analytics_user_milestones (environment, signup_at);

create index if not exists analytics_user_milestones_activated_idx
  on public.analytics_user_milestones (environment, activated_at);

create index if not exists analytics_user_milestones_last_active_idx
  on public.analytics_user_milestones (environment, last_active_at);

create table if not exists public.analytics_anonymous_first_touch (
  anonymous_id text primary key,
  first_touch_source text,
  first_touch_medium text,
  first_touch_campaign text,
  first_touch_content text,
  first_touch_term text,
  first_referrer text,
  first_landing_page text,
  first_touch_at timestamptz not null,
  normalized_source text,
  installer_downloaded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint analytics_anonymous_first_touch_id_len
    check (char_length(anonymous_id) >= 8 and char_length(anonymous_id) <= 160)
);

create table if not exists public.user_acquisition (
  user_id uuid primary key,
  anonymous_id text,
  first_touch_source text,
  first_touch_medium text,
  first_touch_campaign text,
  first_touch_content text,
  first_touch_term text,
  first_referrer text,
  first_landing_page text,
  first_touch_at timestamptz,
  normalized_source text,
  last_touch_source text,
  last_touch_campaign text,
  last_touch_at timestamptz,
  installer_anonymous_match boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists user_acquisition_anonymous_idx
  on public.user_acquisition (anonymous_id)
  where anonymous_id is not null;

create index if not exists user_acquisition_source_idx
  on public.user_acquisition (normalized_source);

alter table public.analytics_user_daily_activity enable row level security;
alter table public.analytics_user_daily_activity force row level security;
alter table public.analytics_user_milestones enable row level security;
alter table public.analytics_user_milestones force row level security;
alter table public.analytics_anonymous_first_touch enable row level security;
alter table public.analytics_anonymous_first_touch force row level security;
alter table public.user_acquisition enable row level security;
alter table public.user_acquisition force row level security;

revoke all on table public.analytics_user_daily_activity from public, anon, authenticated;
revoke all on table public.analytics_user_milestones from public, anon, authenticated;
revoke all on table public.analytics_anonymous_first_touch from public, anon, authenticated;
revoke all on table public.user_acquisition from public, anon, authenticated;

grant select, insert, update, delete on table public.analytics_user_daily_activity to service_role;
grant select, insert, update, delete on table public.analytics_user_milestones to service_role;
grant select, insert, update, delete on table public.analytics_anonymous_first_touch to service_role;
grant select, insert, update, delete on table public.user_acquisition to service_role;

create or replace function public.analytics_resolve_activation(
  saved_at timestamptz,
  cloud_at timestamptz
) returns table (
  activated_at timestamptz,
  activation_source text,
  activation_quality text
)
language sql
immutable
as $$
  select
    public.analytics_earliest(saved_at, cloud_at),
    case
      when saved_at is not null and (cloud_at is null or saved_at <= cloud_at) then 'local_clip'
      when cloud_at is not null then 'cloud_clip'
      else null
    end,
    case
      when saved_at is not null then 'exact'
      when cloud_at is not null then 'cloud_proxy'
      else null
    end;
$$;

create or replace function public.capture_anonymous_first_touch(
  p_anonymous_id text,
  p_source text default null,
  p_medium text default null,
  p_campaign text default null,
  p_content text default null,
  p_term text default null,
  p_referrer text default null,
  p_landing_page text default null,
  p_normalized_source text default null,
  p_first_touch_at timestamptz default now(),
  p_installer_downloaded boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := nullif(trim(p_anonymous_id), '');
begin
  if v_id is null or char_length(v_id) < 8 or char_length(v_id) > 160 then
    return;
  end if;
  insert into public.analytics_anonymous_first_touch (
    anonymous_id, first_touch_source, first_touch_medium, first_touch_campaign,
    first_touch_content, first_touch_term, first_referrer, first_landing_page,
    first_touch_at, normalized_source, installer_downloaded_at, updated_at
  ) values (
    v_id, nullif(trim(p_source), ''), nullif(trim(p_medium), ''), nullif(trim(p_campaign), ''),
    nullif(trim(p_content), ''), nullif(trim(p_term), ''), nullif(trim(p_referrer), ''),
    nullif(trim(p_landing_page), ''), coalesce(p_first_touch_at, now()),
    nullif(trim(p_normalized_source), ''),
    case when p_installer_downloaded then coalesce(p_first_touch_at, now()) else null end,
    now()
  )
  on conflict (anonymous_id) do update set
    first_touch_source = public.analytics_anonymous_first_touch.first_touch_source,
    first_touch_medium = public.analytics_anonymous_first_touch.first_touch_medium,
    first_touch_campaign = public.analytics_anonymous_first_touch.first_touch_campaign,
    first_touch_content = public.analytics_anonymous_first_touch.first_touch_content,
    first_touch_term = public.analytics_anonymous_first_touch.first_touch_term,
    first_referrer = public.analytics_anonymous_first_touch.first_referrer,
    first_landing_page = public.analytics_anonymous_first_touch.first_landing_page,
    first_touch_at = public.analytics_anonymous_first_touch.first_touch_at,
    normalized_source = public.analytics_anonymous_first_touch.normalized_source,
    installer_downloaded_at = public.analytics_earliest(
      public.analytics_anonymous_first_touch.installer_downloaded_at,
      case when p_installer_downloaded then coalesce(p_first_touch_at, now()) else null end
    ),
    updated_at = now();
end;
$$;

create or replace function public.upsert_user_acquisition(
  p_user_id uuid,
  p_anonymous_id text default null,
  p_source text default null,
  p_medium text default null,
  p_campaign text default null,
  p_content text default null,
  p_term text default null,
  p_referrer text default null,
  p_landing_page text default null,
  p_normalized_source text default null,
  p_first_touch_at timestamptz default null,
  p_last_source text default null,
  p_last_campaign text default null,
  p_last_touch_at timestamptz default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anon text := nullif(trim(p_anonymous_id), '');
  v_touch public.analytics_anonymous_first_touch%rowtype;
  v_source text := nullif(trim(p_source), '');
  v_medium text := nullif(trim(p_medium), '');
  v_campaign text := nullif(trim(p_campaign), '');
  v_content text := nullif(trim(p_content), '');
  v_term text := nullif(trim(p_term), '');
  v_referrer text := nullif(trim(p_referrer), '');
  v_landing text := nullif(trim(p_landing_page), '');
  v_normalized text := nullif(trim(p_normalized_source), '');
  v_at timestamptz := p_first_touch_at;
  v_installer boolean := false;
begin
  if p_user_id is null then
    return;
  end if;
  if v_anon is not null then
    select * into v_touch
      from public.analytics_anonymous_first_touch
     where anonymous_id = v_anon;
    if found then
      v_source := coalesce(v_source, v_touch.first_touch_source);
      v_medium := coalesce(v_medium, v_touch.first_touch_medium);
      v_campaign := coalesce(v_campaign, v_touch.first_touch_campaign);
      v_content := coalesce(v_content, v_touch.first_touch_content);
      v_term := coalesce(v_term, v_touch.first_touch_term);
      v_referrer := coalesce(v_referrer, v_touch.first_referrer);
      v_landing := coalesce(v_landing, v_touch.first_landing_page);
      v_normalized := coalesce(v_normalized, v_touch.normalized_source);
      v_at := coalesce(v_at, v_touch.first_touch_at);
      v_installer := v_touch.installer_downloaded_at is not null;
    end if;
  end if;

  insert into public.user_acquisition (
    user_id, anonymous_id, first_touch_source, first_touch_medium, first_touch_campaign,
    first_touch_content, first_touch_term, first_referrer, first_landing_page,
    first_touch_at, normalized_source, last_touch_source, last_touch_campaign,
    last_touch_at, installer_anonymous_match, updated_at
  ) values (
    p_user_id, v_anon, v_source, v_medium, v_campaign, v_content, v_term, v_referrer, v_landing,
    v_at, v_normalized, nullif(trim(p_last_source), ''), nullif(trim(p_last_campaign), ''),
    p_last_touch_at, v_installer, now()
  )
  on conflict (user_id) do update set
    anonymous_id = coalesce(public.user_acquisition.anonymous_id, excluded.anonymous_id),
    first_touch_source = public.user_acquisition.first_touch_source,
    first_touch_medium = public.user_acquisition.first_touch_medium,
    first_touch_campaign = public.user_acquisition.first_touch_campaign,
    first_touch_content = public.user_acquisition.first_touch_content,
    first_touch_term = public.user_acquisition.first_touch_term,
    first_referrer = public.user_acquisition.first_referrer,
    first_landing_page = public.user_acquisition.first_landing_page,
    first_touch_at = public.user_acquisition.first_touch_at,
    normalized_source = public.user_acquisition.normalized_source,
    last_touch_source = coalesce(excluded.last_touch_source, public.user_acquisition.last_touch_source),
    last_touch_campaign = coalesce(excluded.last_touch_campaign, public.user_acquisition.last_touch_campaign),
    last_touch_at = coalesce(excluded.last_touch_at, public.user_acquisition.last_touch_at),
    installer_anonymous_match = public.user_acquisition.installer_anonymous_match or excluded.installer_anonymous_match,
    updated_at = now();

  -- If first-touch was empty on insert conflict, fill it once from this call.
  update public.user_acquisition
     set first_touch_source = coalesce(first_touch_source, v_source),
         first_touch_medium = coalesce(first_touch_medium, v_medium),
         first_touch_campaign = coalesce(first_touch_campaign, v_campaign),
         first_touch_content = coalesce(first_touch_content, v_content),
         first_touch_term = coalesce(first_touch_term, v_term),
         first_referrer = coalesce(first_referrer, v_referrer),
         first_landing_page = coalesce(first_landing_page, v_landing),
         first_touch_at = coalesce(first_touch_at, v_at),
         normalized_source = coalesce(normalized_source, v_normalized),
         anonymous_id = coalesce(anonymous_id, v_anon),
         installer_anonymous_match = installer_anonymous_match or v_installer,
         updated_at = now()
   where user_id = p_user_id
     and first_touch_at is null
     and v_at is not null;
end;
$$;

create or replace function public.rollup_analytics_growth_days(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  db_env text := public.analytics_environment();
  ev text;
  d date;
  days int := 0;
  v_active bigint;
  v_activated bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Range must be [from, to) with to after from.';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'Analytics backfill is limited to 366 days.';
  end if;

  insert into public.analytics_user_daily_activity (
    day, user_id, environment, active, app_opened, clip_saved, clip_uploaded,
    editor_used, rendered, folder_used, event_count, clip_save_count,
    first_event_at, last_event_at, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.user_id,
    e.environment,
    true,
    bool_or(e.event_name = 'app.opened'),
    bool_or(e.event_name = 'clip.saved'),
    bool_or(e.event_name = 'clip.upload_completed'),
    bool_or(e.event_name = 'clip.editor_opened'),
    bool_or(e.event_name = 'clip.rendered'),
    bool_or(e.event_name in ('folder.created', 'folder.clip_added')),
    count(*)::integer,
    count(*) filter (where e.event_name = 'clip.saved')::integer,
    min(e.occurred_at),
    max(e.occurred_at),
    now()
  from public.analytics_events e
  where e.user_id is not null
    and e.occurred_at >= p_from
    and e.occurred_at < p_to
    and e.event_name in (
      'app.opened',
      'clip.saved',
      'clip.upload_completed',
      'clip.played',
      'clip.editor_opened',
      'clip.rendered',
      'folder.created',
      'folder.clip_added'
    )
  group by 1, 2, 3
  on conflict (day, user_id, environment) do update set
    active = true,
    app_opened = public.analytics_user_daily_activity.app_opened or excluded.app_opened,
    clip_saved = public.analytics_user_daily_activity.clip_saved or excluded.clip_saved,
    clip_uploaded = public.analytics_user_daily_activity.clip_uploaded or excluded.clip_uploaded,
    editor_used = public.analytics_user_daily_activity.editor_used or excluded.editor_used,
    rendered = public.analytics_user_daily_activity.rendered or excluded.rendered,
    folder_used = public.analytics_user_daily_activity.folder_used or excluded.folder_used,
    event_count = excluded.event_count,
    clip_save_count = excluded.clip_save_count,
    first_event_at = public.analytics_earliest(public.analytics_user_daily_activity.first_event_at, excluded.first_event_at),
    last_event_at = case
      when public.analytics_user_daily_activity.last_event_at is null then excluded.last_event_at
      when excluded.last_event_at is null then public.analytics_user_daily_activity.last_event_at
      when excluded.last_event_at > public.analytics_user_daily_activity.last_event_at then excluded.last_event_at
      else public.analytics_user_daily_activity.last_event_at
    end,
    updated_at = now();

  -- Historical cloud-proxy activity from ready clips (db env only). Never invent local clip.saved.
  insert into public.analytics_user_daily_activity (
    day, user_id, environment, active, clip_uploaded, event_count, first_event_at, last_event_at, updated_at
  )
  select
    (c.created_at at time zone 'utc')::date,
    c.user_id,
    db_env,
    true,
    true,
    count(*)::integer,
    min(c.created_at),
    max(c.created_at),
    now()
  from public.clips c
  where c.status = 'ready'
    and c.user_id is not null
    and c.created_at >= p_from
    and c.created_at < p_to
  group by 1, 2, 3
  on conflict (day, user_id, environment) do update set
    active = true,
    clip_uploaded = true,
    updated_at = now();

  insert into public.analytics_user_milestones (user_id, environment, signup_at, updated_at)
  select u.id, db_env, u.created_at, now()
    from auth.users u
  on conflict (user_id, environment) do update set
    signup_at = public.analytics_earliest(public.analytics_user_milestones.signup_at, excluded.signup_at),
    updated_at = now();

  insert into public.analytics_user_milestones (user_id, environment, signup_at, updated_at)
  select e.user_id, e.environment, min(e.occurred_at), now()
    from public.analytics_events e
   where e.event_name = 'auth.signup_completed'
     and e.user_id is not null
   group by e.user_id, e.environment
  on conflict (user_id, environment) do update set
    signup_at = public.analytics_earliest(public.analytics_user_milestones.signup_at, excluded.signup_at),
    updated_at = now();

  with firsts as (
    select
      e.user_id,
      e.environment,
      min(e.occurred_at) filter (where e.event_name = 'app.opened') as first_app_open_at,
      min(e.occurred_at) filter (where e.event_name = 'clip.saved') as first_clip_saved_at,
      min(e.occurred_at) filter (where e.event_name = 'clip.upload_completed') as first_cloud_upload_at,
      min(e.occurred_at) filter (where e.event_name = 'clip.editor_opened') as first_editor_open_at,
      min(e.occurred_at) filter (where e.event_name = 'clip.rendered') as first_render_at,
      min(e.occurred_at) filter (where e.event_name = 'clip.shared') as first_share_at,
      min(e.occurred_at) filter (where e.event_name = 'folder.created') as first_folder_at
    from public.analytics_events e
    where e.user_id is not null
      and e.event_name in (
        'app.opened', 'clip.saved', 'clip.upload_completed',
        'clip.editor_opened', 'clip.rendered', 'clip.shared', 'folder.created'
      )
    group by e.user_id, e.environment
  )
  insert into public.analytics_user_milestones (
    user_id, environment, first_app_open_at, first_clip_saved_at, first_cloud_upload_at,
    first_editor_open_at, first_render_at, first_share_at, first_folder_at, updated_at
  )
  select
    user_id, environment, first_app_open_at, first_clip_saved_at, first_cloud_upload_at,
    first_editor_open_at, first_render_at, first_share_at, first_folder_at, now()
  from firsts
  on conflict (user_id, environment) do update set
    first_app_open_at = public.analytics_earliest(public.analytics_user_milestones.first_app_open_at, excluded.first_app_open_at),
    first_clip_saved_at = public.analytics_earliest(public.analytics_user_milestones.first_clip_saved_at, excluded.first_clip_saved_at),
    first_cloud_upload_at = public.analytics_earliest(public.analytics_user_milestones.first_cloud_upload_at, excluded.first_cloud_upload_at),
    first_editor_open_at = public.analytics_earliest(public.analytics_user_milestones.first_editor_open_at, excluded.first_editor_open_at),
    first_render_at = public.analytics_earliest(public.analytics_user_milestones.first_render_at, excluded.first_render_at),
    first_share_at = public.analytics_earliest(public.analytics_user_milestones.first_share_at, excluded.first_share_at),
    first_folder_at = public.analytics_earliest(public.analytics_user_milestones.first_folder_at, excluded.first_folder_at),
    updated_at = now();

  with cloud as (
    select c.user_id, min(c.created_at) as first_cloud_upload_at
      from public.clips c
     where c.status = 'ready'
       and c.user_id is not null
     group by c.user_id
  )
  insert into public.analytics_user_milestones (user_id, environment, first_cloud_upload_at, updated_at)
  select user_id, db_env, first_cloud_upload_at, now()
    from cloud
  on conflict (user_id, environment) do update set
    first_cloud_upload_at = public.analytics_earliest(public.analytics_user_milestones.first_cloud_upload_at, excluded.first_cloud_upload_at),
    updated_at = now();

  update public.analytics_user_milestones m
     set last_active_at = a.last_active_at,
         updated_at = now()
    from (
      select user_id, environment, max(last_event_at) as last_active_at
        from public.analytics_user_daily_activity
       where active
       group by user_id, environment
    ) a
   where m.user_id = a.user_id
     and m.environment = a.environment
     and (m.last_active_at is null or a.last_active_at > m.last_active_at);

  update public.analytics_user_milestones m
     set activated_at = v.activated_at,
         activation_source = v.activation_source,
         activation_quality = v.activation_quality,
         updated_at = now()
    from (
      select
        src.user_id,
        src.environment,
        resolved.activated_at,
        resolved.activation_source,
        resolved.activation_quality
      from public.analytics_user_milestones src
      cross join lateral public.analytics_resolve_activation(
        src.first_clip_saved_at,
        src.first_cloud_upload_at
      ) resolved
    ) v
   where m.user_id = v.user_id
     and m.environment = v.environment
     and v.activated_at is not null
     and (
       m.activated_at is null
       or v.activated_at < m.activated_at
       or (m.activation_quality = 'cloud_proxy' and v.activation_quality = 'exact' and v.activated_at = m.activated_at)
     );

  foreach ev in array array['production', 'development'] loop
    d := p_from;
    while d < p_to loop
      select count(*) into v_active
        from public.analytics_user_daily_activity
       where day = d and environment = ev and active;
      select count(*) into v_activated
        from public.analytics_user_milestones
       where environment = ev
         and activated_at >= d
         and activated_at < (d + 1);

      insert into public.analytics_daily (
        day, environment, new_users, signups, active_users, activated_users, updated_at
      ) values (
        d, ev, 0, 0, v_active, v_activated, now()
      )
      on conflict (day, environment) do update set
        active_users = excluded.active_users,
        activated_users = excluded.activated_users,
        updated_at = now();

      days := days + 1;
      d := d + 1;
    end loop;
  end loop;

  return days;
end;
$$;

revoke all on function public.analytics_earliest(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.analytics_resolve_activation(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.capture_anonymous_first_touch(text, text, text, text, text, text, text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.upsert_user_acquisition(uuid, text, text, text, text, text, text, text, text, text, timestamptz, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.rollup_analytics_growth_days(date, date) from public, anon, authenticated;

grant execute on function public.analytics_earliest(timestamptz, timestamptz) to service_role;
grant execute on function public.analytics_resolve_activation(timestamptz, timestamptz) to service_role;
grant execute on function public.capture_anonymous_first_touch(text, text, text, text, text, text, text, text, text, timestamptz, boolean) to service_role;
grant execute on function public.upsert_user_acquisition(uuid, text, text, text, text, text, text, text, text, text, timestamptz, text, text, timestamptz) to service_role;
grant execute on function public.rollup_analytics_growth_days(date, date) to service_role;

insert into public.analytics_metric_catalog (metric_key, availability, notes, available_from) values
  ('dau', 'INCOMPLETE', 'Unique authenticated users with a qualifying active event that UTC day. Not last_sign_in_at. True DAU needs desktop app.opened / clip.saved. Tracking began 2026-08-31.', '2026-08-31'),
  ('wau', 'INCOMPLETE', 'Unique authenticated users with qualifying activity in a 7-day window. Not the sum of seven DAUs. Incomplete until 7 tracked days.', '2026-09-06'),
  ('mau', 'INCOMPLETE', 'Unique authenticated users with qualifying activity in a 30-day window. Not the sum of DAUs. Incomplete until 30 tracked days.', '2026-09-29'),
  ('dau_mau', 'INCOMPLETE', 'DAU / MAU stickiness. Hidden until both windows are mature.', '2026-09-29'),
  ('activated_users', 'INCOMPLETE', 'First clip.saved or clip.upload_completed. Historical cloud-only activations are cloud_proxy.', '2026-08-31'),
  ('activation_rate_7d', 'INCOMPLETE', 'Share of a signup cohort that activated within 7 days. Cohort-based, not same-week activations / same-week signups.', '2026-09-07'),
  ('time_to_activation', 'INCOMPLETE', 'Median signup → activation for exact (clip.saved) users only.', '2026-08-31'),
  ('retention_d1', 'INCOMPLETE', 'Exact calendar day 1 after signup or activation. Null until mature.', '2026-09-01'),
  ('retention_d7', 'INCOMPLETE', 'Exact calendar day 7 after signup or activation. Null until mature.', '2026-09-07'),
  ('retention_d30', 'INCOMPLETE', 'Exact calendar day 30 after signup or activation. Null until mature.', '2026-09-30'),
  ('clips_saved', 'AVAILABLE', 'Local clip.saved after a successful desktop save. Tracking began 2026-08-31.', '2026-08-31'),
  ('attribution_coverage', 'AVAILABLE', 'Share of new users with a known first-touch source. Unknown is not Direct.', '2026-08-31')
on conflict (metric_key) do update set
  availability = excluded.availability,
  notes = excluded.notes,
  available_from = excluded.available_from;
