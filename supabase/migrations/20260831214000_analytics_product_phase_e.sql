-- Phase E: games, features, filters, folders, sharing, clip-event columns.
-- Observational only. Does not invent pre-instrumentation product activity.

alter table public.app_settings
  add column if not exists analytics_last_scheduled_rollup_at timestamptz;

create table if not exists public.analytics_game_daily (
  day date not null,
  environment text not null,
  game_slug text not null,
  game_id uuid,
  game_name text not null,
  cloud_clips bigint not null default 0,
  unique_uploaders bigint not null default 0,
  cloud_bytes bigint not null default 0,
  public_views bigint not null default 0,
  clips_saved bigint,
  unique_savers bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment, game_slug),
  constraint analytics_game_daily_env_check
    check (environment in ('production', 'development'))
);

create index if not exists analytics_game_daily_env_day_idx
  on public.analytics_game_daily (environment, day);

create table if not exists public.analytics_user_game_first (
  user_id uuid not null,
  environment text not null,
  game_slug text not null,
  game_id uuid,
  first_ready_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, environment),
  constraint analytics_user_game_first_env_check
    check (environment in ('production', 'development'))
);

create index if not exists analytics_user_game_first_game_idx
  on public.analytics_user_game_first (environment, game_slug);

create table if not exists public.analytics_feature_daily (
  day date not null,
  environment text not null,
  feature_key text not null,
  unique_users bigint not null default 0,
  event_count bigint not null default 0,
  repeat_users bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, environment, feature_key),
  constraint analytics_feature_daily_env_check
    check (environment in ('production', 'development'))
);

create index if not exists analytics_feature_daily_env_day_idx
  on public.analytics_feature_daily (environment, day);

create table if not exists public.analytics_filter_daily (
  day date not null,
  environment text not null,
  filter_id text not null,
  selected_count bigint not null default 0,
  applied_count bigint not null default 0,
  rendered_count bigint not null default 0,
  unique_users bigint not null default 0,
  shared_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, environment, filter_id),
  constraint analytics_filter_daily_env_check
    check (environment in ('production', 'development'))
);

create table if not exists public.analytics_folder_daily (
  day date not null,
  environment text not null,
  folders_created bigint not null default 0,
  clips_added bigint not null default 0,
  invites_sent bigint not null default 0,
  invites_accepted bigint not null default 0,
  public_links_enabled bigint not null default 0,
  unique_owners bigint not null default 0,
  unique_collaborators bigint not null default 0,
  unique_folder_users bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, environment),
  constraint analytics_folder_daily_env_check
    check (environment in ('production', 'development'))
);

create table if not exists public.analytics_sharing_daily (
  day date not null,
  environment text not null,
  clips_shared bigint,
  unique_sharers bigint,
  public_clip_views bigint not null default 0,
  clip_downloads_public bigint,
  folder_public_downloads bigint,
  installer_downloads bigint,
  updated_at timestamptz not null default now(),
  primary key (day, environment),
  constraint analytics_sharing_daily_env_check
    check (environment in ('production', 'development'))
);

create or replace function public.analytics_feature_key(event_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select case event_name
    when 'app.opened' then 'app_open'
    when 'clip.saved' then 'clip_save'
    when 'clip.upload_completed' then 'cloud_upload'
    when 'clip.editor_opened' then 'editor'
    when 'clip.rendered' then 'render'
    when 'clip.played' then 'play'
    when 'clip.shared' then 'share'
    when 'folder.created' then 'folder'
    when 'folder.clip_added' then 'folder'
    when 'visual.filter_selected' then 'filter'
    when 'visual.filter_applied' then 'filter'
    when 'visual.filter_rendered' then 'filter'
    when 'capture.started' then 'capture'
    when 'replay.enabled' then 'replay'
    else null
  end;
$$;

create or replace function public.rollup_analytics_product_days(p_from date, p_to date)
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
  v_saved bigint;
  v_failed bigint;
  v_shared bigint;
  v_rendered bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Range must be [from, to) with to after from.';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'Analytics backfill is limited to 366 days.';
  end if;

  -- First ready cloud clip's game. Never move later.
  insert into public.analytics_user_game_first (
    user_id, environment, game_slug, game_id, first_ready_at, updated_at
  )
  select distinct on (c.user_id)
    c.user_id,
    db_env,
    coalesce(g.slug, 'unknown'),
    c.game_id,
    c.created_at,
    now()
  from public.clips c
  left join public.games g on g.id = c.game_id
  where c.status = 'ready'
  order by c.user_id, c.created_at, c.id
  on conflict (user_id, environment) do update set
    game_slug = public.analytics_user_game_first.game_slug,
    game_id = public.analytics_user_game_first.game_id,
    first_ready_at = public.analytics_user_game_first.first_ready_at,
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name,
    cloud_clips, unique_uploaders, cloud_bytes, public_views,
    clips_saved, unique_savers, updated_at
  )
  select
    (c.created_at at time zone 'utc')::date,
    db_env,
    coalesce(g.slug, 'unknown'),
    min(c.game_id::text)::uuid,
    coalesce(min(g.name), 'Unknown'),
    count(*) filter (where c.status = 'ready'),
    count(distinct c.user_id) filter (where c.status = 'ready'),
    coalesce(sum(c.file_size_bytes) filter (where c.status = 'ready'), 0),
    0,
    null,
    null,
    now()
  from public.clips c
  left join public.games g on g.id = c.game_id
  where c.created_at >= p_from
    and c.created_at < p_to
    and c.status = 'ready'
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    game_id = coalesce(excluded.game_id, public.analytics_game_daily.game_id),
    game_name = excluded.game_name,
    cloud_clips = excluded.cloud_clips,
    unique_uploaders = excluded.unique_uploaders,
    cloud_bytes = excluded.cloud_bytes,
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name, public_views, updated_at
  )
  select
    v.day,
    db_env,
    coalesce(g.slug, 'unknown'),
    min(c.game_id::text)::uuid,
    coalesce(min(g.name), 'Unknown'),
    sum(v.count),
    now()
  from public.clip_daily_views v
  join public.clips c on c.id = v.clip_id
  left join public.games g on g.id = c.game_id
  where v.day >= p_from
    and v.day < p_to
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    public_views = excluded.public_views,
    game_id = coalesce(public.analytics_game_daily.game_id, excluded.game_id),
    game_name = coalesce(nullif(public.analytics_game_daily.game_name, 'Unknown'), excluded.game_name),
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name, clips_saved, unique_savers, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.environment,
    coalesce(nullif(e.properties->>'game_slug', ''), 'unknown'),
    null,
    coalesce(nullif(e.properties->>'game_slug', ''), 'unknown'),
    count(*),
    count(distinct e.user_id),
    now()
  from public.analytics_events e
  where e.event_name = 'clip.saved'
    and e.occurred_at >= p_from
    and e.occurred_at < p_to
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    clips_saved = excluded.clips_saved,
    unique_savers = excluded.unique_savers,
    updated_at = now();

  insert into public.analytics_feature_daily (
    day, environment, feature_key, unique_users, event_count, repeat_users, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.environment,
    public.analytics_feature_key(e.event_name),
    count(distinct e.user_id),
    count(*),
    count(*) filter (where u.n >= 2),
    now()
  from public.analytics_events e
  join lateral (
    select count(*) as n
    from public.analytics_events x
    where x.user_id is not distinct from e.user_id
      and x.environment = e.environment
      and (x.occurred_at at time zone 'utc')::date = (e.occurred_at at time zone 'utc')::date
      and public.analytics_feature_key(x.event_name) = public.analytics_feature_key(e.event_name)
  ) u on true
  where e.occurred_at >= p_from
    and e.occurred_at < p_to
    and e.user_id is not null
    and public.analytics_feature_key(e.event_name) is not null
  group by 1, 2, 3
  on conflict (day, environment, feature_key) do update set
    unique_users = excluded.unique_users,
    event_count = excluded.event_count,
    repeat_users = excluded.repeat_users,
    updated_at = now();

  insert into public.analytics_filter_daily (
    day, environment, filter_id, selected_count, applied_count, rendered_count,
    unique_users, shared_count, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.environment,
    coalesce(nullif(e.properties->>'filter_id', ''), 'unknown'),
    count(*) filter (where e.event_name = 'visual.filter_selected'),
    count(*) filter (where e.event_name = 'visual.filter_applied'),
    count(*) filter (where e.event_name = 'visual.filter_rendered'),
    count(distinct e.user_id),
    count(*) filter (where e.event_name = 'clip.shared'),
    now()
  from public.analytics_events e
  where e.occurred_at >= p_from
    and e.occurred_at < p_to
    and (
      e.event_name in ('visual.filter_selected', 'visual.filter_applied', 'visual.filter_rendered')
      or (e.event_name = 'clip.shared' and e.properties ? 'filter_id')
    )
    and coalesce(nullif(e.properties->>'filter_id', ''), '') <> ''
  group by 1, 2, 3
  on conflict (day, environment, filter_id) do update set
    selected_count = excluded.selected_count,
    applied_count = excluded.applied_count,
    rendered_count = excluded.rendered_count,
    unique_users = excluded.unique_users,
    shared_count = excluded.shared_count,
    updated_at = now();

  foreach ev in array array['production', 'development'] loop
    d := p_from;
    while d < p_to loop
      select
        count(*) filter (where event_name = 'clip.saved'),
        count(*) filter (where event_name = 'clip.save_failed'),
        count(*) filter (where event_name = 'clip.shared'),
        count(*) filter (where event_name = 'clip.rendered')
        into v_saved, v_failed, v_shared, v_rendered
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
        and event_name in ('clip.saved', 'clip.save_failed', 'clip.shared', 'clip.rendered');

      insert into public.analytics_clips_daily (
        day, environment, cloud_upload_completed, clips_saved, clip_save_failed,
        clips_shared, clips_rendered, updated_at
      ) values (
        d, ev, 0, v_saved, v_failed, v_shared, v_rendered, now()
      )
      on conflict (day, environment) do update set
        clips_saved = excluded.clips_saved,
        clip_save_failed = excluded.clip_save_failed,
        clips_shared = excluded.clips_shared,
        clips_rendered = excluded.clips_rendered,
        updated_at = now();

      insert into public.analytics_folder_daily (
        day, environment, folders_created, clips_added, invites_sent, invites_accepted,
        public_links_enabled, unique_owners, unique_collaborators, unique_folder_users, updated_at
      )
      select
        d,
        ev,
        case when ev = db_env then (select count(*) from public.folders where created_at >= d and created_at < (d + 1)) else
          (select count(*) from public.analytics_events where event_name = 'folder.created' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (select count(*) from public.folder_clips where created_at >= d and created_at < (d + 1)) else
          (select count(*) from public.analytics_events where event_name = 'folder.clip_added' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (select count(*) from public.folder_invites where created_at >= d and created_at < (d + 1)) else
          (select count(*) from public.analytics_events where event_name = 'folder.invite_sent' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (select count(*) from public.folder_invites where status = 'accepted' and created_at >= d and created_at < (d + 1)) else
          (select count(*) from public.analytics_events where event_name = 'folder.invite_accepted' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (select count(*) from public.folders where public_enabled and public_enabled_at >= d and public_enabled_at < (d + 1)) else
          (select count(*) from public.analytics_events where event_name = 'folder.public_link_enabled' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (
          select count(distinct owner_id) from public.folders where created_at < (d + 1)
        ) else 0 end,
        case when ev = db_env then (
          select count(distinct user_id) from public.folder_members where created_at < (d + 1)
        ) else 0 end,
        case when ev = db_env then (
          select count(*) from (
            select owner_id as user_id from public.folders where created_at < (d + 1)
            union
            select user_id from public.folder_members where created_at < (d + 1)
          ) u
        ) else 0 end,
        now()
      on conflict (day, environment) do update set
        folders_created = excluded.folders_created,
        clips_added = excluded.clips_added,
        invites_sent = excluded.invites_sent,
        invites_accepted = excluded.invites_accepted,
        public_links_enabled = excluded.public_links_enabled,
        unique_owners = excluded.unique_owners,
        unique_collaborators = excluded.unique_collaborators,
        unique_folder_users = excluded.unique_folder_users,
        updated_at = now();

      insert into public.analytics_sharing_daily (
        day, environment, clips_shared, unique_sharers, public_clip_views,
        clip_downloads_public, folder_public_downloads, installer_downloads, updated_at
      )
      select
        d,
        ev,
        (select count(*) from public.analytics_events where event_name = 'clip.shared' and environment = ev and occurred_at >= d and occurred_at < (d + 1)),
        (select count(distinct user_id) from public.analytics_events where event_name = 'clip.shared' and environment = ev and user_id is not null and occurred_at >= d and occurred_at < (d + 1)),
        case when ev = db_env then coalesce((select sum(count) from public.clip_daily_views where day = d), 0) else 0 end,
        (select clip_downloads_public from public.analytics_downloads_daily where day = d and environment = ev),
        (select folder_public_downloads from public.analytics_downloads_daily where day = d and environment = ev),
        (select installer_downloads from public.analytics_downloads_daily where day = d and environment = ev),
        now()
      on conflict (day, environment) do update set
        clips_shared = excluded.clips_shared,
        unique_sharers = excluded.unique_sharers,
        public_clip_views = excluded.public_clip_views,
        clip_downloads_public = excluded.clip_downloads_public,
        folder_public_downloads = excluded.folder_public_downloads,
        installer_downloads = excluded.installer_downloads,
        updated_at = now();

      days := days + 1;
      d := d + 1;
    end loop;
  end loop;

  return days;
end;
$$;

-- Repeat-user count without the correlated join: rewrite feature rollup more cheaply.
create or replace function public.rollup_analytics_product_days(p_from date, p_to date)
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
  v_saved bigint;
  v_failed bigint;
  v_shared bigint;
  v_rendered bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Range must be [from, to) with to after from.';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'Analytics backfill is limited to 366 days.';
  end if;

  insert into public.analytics_user_game_first (
    user_id, environment, game_slug, game_id, first_ready_at, updated_at
  )
  select distinct on (c.user_id)
    c.user_id,
    db_env,
    coalesce(g.slug, 'unknown'),
    c.game_id,
    c.created_at,
    now()
  from public.clips c
  left join public.games g on g.id = c.game_id
  where c.status = 'ready'
  order by c.user_id, c.created_at, c.id
  on conflict (user_id, environment) do update set
    game_slug = public.analytics_user_game_first.game_slug,
    game_id = public.analytics_user_game_first.game_id,
    first_ready_at = public.analytics_user_game_first.first_ready_at,
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name,
    cloud_clips, unique_uploaders, cloud_bytes, public_views,
    clips_saved, unique_savers, updated_at
  )
  select
    (c.created_at at time zone 'utc')::date,
    db_env,
    coalesce(g.slug, 'unknown'),
    (array_agg(c.game_id) filter (where c.game_id is not null))[1],
    coalesce((array_agg(g.name) filter (where g.name is not null))[1], 'Unknown'),
    count(*)::bigint,
    count(distinct c.user_id)::bigint,
    coalesce(sum(c.file_size_bytes), 0)::bigint,
    0,
    null,
    null,
    now()
  from public.clips c
  left join public.games g on g.id = c.game_id
  where c.created_at >= p_from
    and c.created_at < p_to
    and c.status = 'ready'
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    game_id = coalesce(excluded.game_id, public.analytics_game_daily.game_id),
    game_name = excluded.game_name,
    cloud_clips = excluded.cloud_clips,
    unique_uploaders = excluded.unique_uploaders,
    cloud_bytes = excluded.cloud_bytes,
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name,
    cloud_clips, unique_uploaders, cloud_bytes, public_views, updated_at
  )
  select
    v.day,
    db_env,
    coalesce(g.slug, 'unknown'),
    (array_agg(c.game_id) filter (where c.game_id is not null))[1],
    coalesce((array_agg(g.name) filter (where g.name is not null))[1], 'Unknown'),
    0, 0, 0,
    sum(v.count)::bigint,
    now()
  from public.clip_daily_views v
  join public.clips c on c.id = v.clip_id
  left join public.games g on g.id = c.game_id
  where v.day >= p_from
    and v.day < p_to
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    public_views = excluded.public_views,
    game_id = coalesce(public.analytics_game_daily.game_id, excluded.game_id),
    game_name = case
      when public.analytics_game_daily.game_name is null or public.analytics_game_daily.game_name = 'unknown'
        then excluded.game_name
      else public.analytics_game_daily.game_name
    end,
    updated_at = now();

  insert into public.analytics_game_daily (
    day, environment, game_slug, game_id, game_name,
    cloud_clips, unique_uploaders, cloud_bytes, public_views, clips_saved, unique_savers, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.environment,
    coalesce(nullif(e.properties->>'game_slug', ''), 'unknown'),
    null,
    coalesce(nullif(e.properties->>'game_slug', ''), 'unknown'),
    0, 0, 0, 0,
    count(*)::bigint,
    count(distinct e.user_id)::bigint,
    now()
  from public.analytics_events e
  where e.event_name = 'clip.saved'
    and e.occurred_at >= p_from
    and e.occurred_at < p_to
  group by 1, 2, 3
  on conflict (day, environment, game_slug) do update set
    clips_saved = excluded.clips_saved,
    unique_savers = excluded.unique_savers,
    updated_at = now();

  insert into public.analytics_feature_daily (
    day, environment, feature_key, unique_users, event_count, repeat_users, updated_at
  )
  select
    day,
    environment,
    feature_key,
    count(*)::bigint,
    sum(n)::bigint,
    count(*) filter (where n >= 2)::bigint,
    now()
  from (
    select
      (occurred_at at time zone 'utc')::date as day,
      environment,
      public.analytics_feature_key(event_name) as feature_key,
      user_id,
      count(*) as n
    from public.analytics_events
    where occurred_at >= p_from
      and occurred_at < p_to
      and user_id is not null
      and public.analytics_feature_key(event_name) is not null
    group by 1, 2, 3, 4
  ) per_user
  group by 1, 2, 3
  on conflict (day, environment, feature_key) do update set
    unique_users = excluded.unique_users,
    event_count = excluded.event_count,
    repeat_users = excluded.repeat_users,
    updated_at = now();

  insert into public.analytics_filter_daily (
    day, environment, filter_id, selected_count, applied_count, rendered_count,
    unique_users, shared_count, updated_at
  )
  select
    (e.occurred_at at time zone 'utc')::date,
    e.environment,
    e.properties->>'filter_id',
    count(*) filter (where e.event_name = 'visual.filter_selected'),
    count(*) filter (where e.event_name = 'visual.filter_applied'),
    count(*) filter (where e.event_name in ('visual.filter_rendered', 'clip.saved', 'clip.rendered') and e.event_name <> 'visual.filter_selected'),
    count(distinct e.user_id),
    count(*) filter (where e.event_name = 'clip.shared'),
    now()
  from public.analytics_events e
  where e.occurred_at >= p_from
    and e.occurred_at < p_to
    and nullif(e.properties->>'filter_id', '') is not null
    and e.event_name in (
      'visual.filter_selected',
      'visual.filter_applied',
      'visual.filter_rendered',
      'clip.saved',
      'clip.rendered',
      'clip.shared'
    )
  group by 1, 2, 3
  on conflict (day, environment, filter_id) do update set
    selected_count = excluded.selected_count,
    applied_count = excluded.applied_count,
    rendered_count = excluded.rendered_count,
    unique_users = excluded.unique_users,
    shared_count = excluded.shared_count,
    updated_at = now();

  foreach ev in array array['production', 'development'] loop
    d := p_from;
    while d < p_to loop
      select
        count(*) filter (where event_name = 'clip.saved'),
        count(*) filter (where event_name = 'clip.save_failed'),
        count(*) filter (where event_name = 'clip.shared'),
        count(*) filter (where event_name = 'clip.rendered')
        into v_saved, v_failed, v_shared, v_rendered
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
        and event_name in ('clip.saved', 'clip.save_failed', 'clip.shared', 'clip.rendered');

      insert into public.analytics_clips_daily (
        day, environment, cloud_upload_completed, clips_saved, clip_save_failed,
        clips_shared, clips_rendered, updated_at
      ) values (
        d, ev, 0, v_saved, v_failed, v_shared, v_rendered, now()
      )
      on conflict (day, environment) do update set
        clips_saved = excluded.clips_saved,
        clip_save_failed = excluded.clip_save_failed,
        clips_shared = excluded.clips_shared,
        clips_rendered = excluded.clips_rendered,
        updated_at = now();

      insert into public.analytics_folder_daily (
        day, environment, folders_created, clips_added, invites_sent, invites_accepted,
        public_links_enabled, unique_owners, unique_collaborators, unique_folder_users, updated_at
      ) values (
        d,
        ev,
        case when ev = db_env
          then (select count(*) from public.folders where created_at >= d and created_at < (d + 1))
          else (select count(*) from public.analytics_events where event_name = 'folder.created' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env
          then (select count(*) from public.folder_clips where created_at >= d and created_at < (d + 1))
          else (select count(*) from public.analytics_events where event_name = 'folder.clip_added' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env
          then (select count(*) from public.folder_invites where created_at >= d and created_at < (d + 1))
          else (select count(*) from public.analytics_events where event_name = 'folder.invite_sent' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env
          then (select count(*) from public.folder_members where created_at >= d and created_at < (d + 1))
          else (select count(*) from public.analytics_events where event_name = 'folder.invite_accepted' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env
          then (select count(*) from public.folders where public_enabled and public_enabled_at >= d and public_enabled_at < (d + 1))
          else (select count(*) from public.analytics_events where event_name = 'folder.public_link_enabled' and environment = ev and occurred_at >= d and occurred_at < (d + 1))
        end,
        case when ev = db_env then (select count(distinct owner_id) from public.folders where created_at < (d + 1)) else 0 end,
        case when ev = db_env then (select count(distinct user_id) from public.folder_members where created_at < (d + 1)) else 0 end,
        case when ev = db_env then (
          select count(*) from (
            select owner_id as uid from public.folders where created_at < (d + 1)
            union
            select user_id from public.folder_members where created_at < (d + 1)
          ) u
        ) else 0 end,
        now()
      )
      on conflict (day, environment) do update set
        folders_created = excluded.folders_created,
        clips_added = excluded.clips_added,
        invites_sent = excluded.invites_sent,
        invites_accepted = excluded.invites_accepted,
        public_links_enabled = excluded.public_links_enabled,
        unique_owners = excluded.unique_owners,
        unique_collaborators = excluded.unique_collaborators,
        unique_folder_users = excluded.unique_folder_users,
        updated_at = now();

      insert into public.analytics_sharing_daily (
        day, environment, clips_shared, unique_sharers, public_clip_views,
        clip_downloads_public, folder_public_downloads, installer_downloads, updated_at
      ) values (
        d,
        ev,
        (select count(*) from public.analytics_events where event_name = 'clip.shared' and environment = ev and occurred_at >= d and occurred_at < (d + 1)),
        (select count(distinct user_id) from public.analytics_events where event_name = 'clip.shared' and environment = ev and user_id is not null and occurred_at >= d and occurred_at < (d + 1)),
        case when ev = db_env then coalesce((select sum(count) from public.clip_daily_views where day = d), 0) else 0 end,
        (select clip_downloads_public from public.analytics_downloads_daily where day = d and environment = ev),
        (select folder_public_downloads from public.analytics_downloads_daily where day = d and environment = ev),
        (select installer_downloads from public.analytics_downloads_daily where day = d and environment = ev),
        now()
      )
      on conflict (day, environment) do update set
        clips_shared = excluded.clips_shared,
        unique_sharers = excluded.unique_sharers,
        public_clip_views = excluded.public_clip_views,
        clip_downloads_public = excluded.clip_downloads_public,
        folder_public_downloads = excluded.folder_public_downloads,
        installer_downloads = excluded.installer_downloads,
        updated_at = now();

      days := days + 1;
      d := d + 1;
    end loop;
  end loop;

  return days;
end;
$$;

alter table public.analytics_game_daily enable row level security;
alter table public.analytics_user_game_first enable row level security;
alter table public.analytics_feature_daily enable row level security;
alter table public.analytics_filter_daily enable row level security;
alter table public.analytics_folder_daily enable row level security;
alter table public.analytics_sharing_daily enable row level security;
alter table public.analytics_game_daily force row level security;
alter table public.analytics_user_game_first force row level security;
alter table public.analytics_feature_daily force row level security;
alter table public.analytics_filter_daily force row level security;
alter table public.analytics_folder_daily force row level security;
alter table public.analytics_sharing_daily force row level security;

revoke all on table public.analytics_game_daily from public, anon, authenticated;
revoke all on table public.analytics_user_game_first from public, anon, authenticated;
revoke all on table public.analytics_feature_daily from public, anon, authenticated;
revoke all on table public.analytics_filter_daily from public, anon, authenticated;
revoke all on table public.analytics_folder_daily from public, anon, authenticated;
revoke all on table public.analytics_sharing_daily from public, anon, authenticated;
grant select, insert, update, delete on table public.analytics_game_daily to service_role;
grant select, insert, update, delete on table public.analytics_user_game_first to service_role;
grant select, insert, update, delete on table public.analytics_feature_daily to service_role;
grant select, insert, update, delete on table public.analytics_filter_daily to service_role;
grant select, insert, update, delete on table public.analytics_folder_daily to service_role;
grant select, insert, update, delete on table public.analytics_sharing_daily to service_role;

revoke all on function public.analytics_feature_key(text) from public, anon, authenticated;
revoke all on function public.rollup_analytics_product_days(date, date) from public, anon, authenticated;
grant execute on function public.analytics_feature_key(text) to service_role;
grant execute on function public.rollup_analytics_product_days(date, date) to service_role;

insert into public.analytics_metric_catalog (metric_key, availability, notes, available_from) values
  ('top_games', 'AVAILABLE', 'Ready cloud clips by normalized games.slug. Unknown is clips with no game_id. Not raw exe names.', null),
  ('game_community_retention_d7', 'INCOMPLETE', 'Exact-day D7 after a user''s first ready cloud clip of that game. Cloud-clip cohort only.', '2026-08-31'),
  ('top_filters', 'INCOMPLETE', 'visual.filter_* plus clip.saved/rendered filter_id. None is stored but not treated as a used filter.', '2026-08-31'),
  ('feature_adoption', 'INCOMPLETE', 'Unique users with that feature event / active users. Capture and replay are adoption-only, not DAU.', '2026-08-31'),
  ('folder_adoption', 'AVAILABLE', 'Folders, clip adds, invites, and public links from folder tables on the production DB environment.', null),
  ('folder_user_engagement', 'INCOMPLETE', 'Active-day rate of folder owners/members vs everyone else. Needs true DAU.', '2026-08-31'),
  ('clips_shared', 'INCOMPLETE', 'clip.shared after a successful send or copy-link. Tracking began 2026-08-31.', '2026-08-31'),
  ('share_to_download', 'NOT_INSTRUMENTED', 'Shared content is not identity-stitched to installer downloads. Period-level views/downloads only.', null),
  ('clips_per_active_user', 'INCOMPLETE', 'clip.saved / DAU in the selected range. Null until both exist.', '2026-08-31'),
  ('power_users', 'PROXY', 'Top decile of ready cloud clips in the selected range. Event-based power behaviors are incomplete.', null)
on conflict (metric_key) do update set
  availability = excluded.availability,
  notes = excluded.notes,
  available_from = excluded.available_from;
