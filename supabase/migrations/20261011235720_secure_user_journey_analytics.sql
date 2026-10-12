-- Privacy-first named journey analytics.
-- Raw events are pseudonymous; identity is derived by the Worker with a
-- versioned HMAC key that never enters Postgres.

create table if not exists public.user_analytics_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  consent text not null default 'unset'
    check (consent in ('unset', 'allowed', 'denied')),
  consented_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint user_analytics_preferences_consent_time_check
    check (
      (consent = 'allowed' and consented_at is not null)
      or (consent <> 'allowed' and consented_at is null)
    )
);

alter table public.user_analytics_preferences enable row level security;
alter table public.user_analytics_preferences force row level security;
revoke all on table public.user_analytics_preferences from public, anon, authenticated;
grant select, insert, update, delete on table public.user_analytics_preferences to service_role;

alter table public.analytics_events
  add column if not exists subject_id text,
  add column if not exists subject_key_version smallint,
  add column if not exists behavioral_consent boolean not null default false;

-- A Worker HMAC is the only durable journey identifier. Existing direct
-- identity links are removed instead of being retained through rollout.
update public.analytics_events
   set user_id = null,
       anonymous_id = null,
       session_id = null,
       idempotency_key = null,
       properties = '{}'::jsonb,
       acquisition_source = null,
       utm_source = null,
       utm_medium = null,
       utm_campaign = null,
       utm_content = null,
       utm_term = null;

delete from public.analytics_user_daily_activity;
delete from public.analytics_user_milestones;
delete from public.analytics_user_game_first;
delete from public.analytics_user_paid_first;
delete from public.user_acquisition;
delete from public.live_visitors;
update public.product_events set dims = '{}'::jsonb;

alter table public.analytics_events
  drop constraint if exists analytics_events_subject_pair_check;
alter table public.analytics_events
  add constraint analytics_events_subject_pair_check check (
    (subject_id is null and subject_key_version is null)
    or (
      subject_id ~ '^[0-9a-f]{64}$'
      and subject_key_version is not null
      and subject_key_version > 0
    )
  );

alter table public.analytics_events
  drop constraint if exists analytics_events_no_direct_identity_check;
alter table public.analytics_events
  add constraint analytics_events_no_direct_identity_check check (
    user_id is null and anonymous_id is null
  );

create index if not exists analytics_events_subject_occurred_idx
  on public.analytics_events (subject_id, occurred_at desc)
  where subject_id is not null;

-- Pseudonymous ingest overload. Direct identity parameters are accepted only
-- for a safe rolling deploy and are deliberately never persisted.
create or replace function public.ingest_analytics_event(
  p_id uuid,
  p_idempotency_key text,
  p_user_id uuid,
  p_anonymous_id text,
  p_session_id text,
  p_event_name text,
  p_event_version integer,
  p_platform text,
  p_app_version text,
  p_os text,
  p_device_type text,
  p_environment text,
  p_properties jsonb,
  p_acquisition_source text,
  p_utm_source text,
  p_utm_medium text,
  p_utm_campaign text,
  p_utm_content text,
  p_utm_term text,
  p_country_code text,
  p_occurred_at timestamptz,
  p_subject_id text,
  p_subject_key_version smallint,
  p_behavioral_consent boolean
)
returns table (inserted boolean, event_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_inserted boolean := false;
begin
  if p_event_name is null or length(trim(p_event_name)) = 0 then
    raise exception 'invalid analytics event name';
  end if;
  if (p_subject_id is null) <> (p_subject_key_version is null) then
    raise exception 'analytics subject id and key version must be paired';
  end if;

  insert into public.analytics_events (
    id,
    idempotency_key,
    user_id,
    anonymous_id,
    session_id,
    event_name,
    event_version,
    platform,
    app_version,
    os,
    device_type,
    environment,
    properties,
    acquisition_source,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    country_code,
    occurred_at,
    subject_id,
    subject_key_version,
    behavioral_consent
  ) values (
    coalesce(p_id, gen_random_uuid()),
    nullif(trim(p_idempotency_key), ''),
    null,
    null,
    nullif(trim(p_session_id), ''),
    trim(p_event_name),
    coalesce(p_event_version, 1),
    nullif(trim(p_platform), ''),
    nullif(trim(p_app_version), ''),
    nullif(trim(p_os), ''),
    nullif(trim(p_device_type), ''),
    p_environment,
    coalesce(p_properties, '{}'::jsonb),
    nullif(trim(p_acquisition_source), ''),
    nullif(trim(p_utm_source), ''),
    nullif(trim(p_utm_medium), ''),
    nullif(trim(p_utm_campaign), ''),
    nullif(trim(p_utm_content), ''),
    nullif(trim(p_utm_term), ''),
    nullif(upper(trim(p_country_code)), ''),
    coalesce(p_occurred_at, now()),
    lower(nullif(trim(p_subject_id), '')),
    p_subject_key_version,
    coalesce(p_behavioral_consent, false)
  )
  on conflict (idempotency_key) do nothing
  returning analytics_events.id into v_id;

  if v_id is null and p_idempotency_key is not null and length(trim(p_idempotency_key)) > 0 then
    select analytics_events.id
      into v_id
      from public.analytics_events
     where analytics_events.idempotency_key = trim(p_idempotency_key);
    v_inserted := false;
  else
    v_inserted := v_id is not null;
  end if;

  return query select v_inserted, v_id;
end;
$$;

revoke all on function public.ingest_analytics_event(
  uuid, text, uuid, text, text, text, integer, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, timestamptz, text, smallint, boolean
) from public, anon, authenticated;
grant execute on function public.ingest_analytics_event(
  uuid, text, uuid, text, text, text, integer, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, timestamptz, text, smallint, boolean
) to service_role;

-- Remove the pre-pseudonymization overload so an older caller cannot restore
-- direct account or anonymous identifiers to raw analytics.
drop function if exists public.ingest_analytics_event(
  uuid, text, uuid, text, text, text, integer, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, timestamptz
);

-- Keep the aggregate signup signal without writing the account UUID into an
-- event column or idempotency key.
create or replace function public.emit_signup_analytics()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.analytics_events (
      event_name,
      event_version,
      platform,
      environment,
      properties,
      occurred_at
    ) values (
      'auth.signup_completed',
      1,
      'server',
      'production',
      '{}'::jsonb,
      coalesce(new.created_at, now())
    );
  exception
    when others then
      null;
  end;
  return new;
end;
$$;
revoke all on function public.emit_signup_analytics()
  from public, anon, authenticated;
grant execute on function public.emit_signup_analytics()
  to supabase_auth_admin;

-- Service-role retention helper. SECURITY INVOKER keeps privileges explicit.
grant delete on table public.analytics_events to service_role;
create or replace function public.purge_expired_analytics_events(
  p_before timestamptz default (now() - interval '30 days')
)
returns bigint
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_deleted bigint;
begin
  delete from public.analytics_events where received_at < p_before;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.purge_expired_analytics_events(timestamptz)
  from public, anon, authenticated;
grant execute on function public.purge_expired_analytics_events(timestamptz)
  to service_role;

insert into public.staff_permissions (key, category, label, description, sort)
values
  (
    'analytics.users.view',
    'analytics',
    'View named user journeys',
    'Use an MFA-protected and audited reveal flow for pseudonymous user journeys.',
    950
  ),
  (
    'analytics.live',
    'analytics',
    'View live visitors',
    'Open the restricted live visitor surface.',
    960
  )
on conflict (key) do update set
  category = excluded.category,
  label = excluded.label,
  description = excluded.description,
  sort = excluded.sort;

-- Existing analytics tables are intentionally service-role only. Explicit
-- deny policies document and test that posture in addition to revoked grants.
do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and (
         c.relname like 'analytics\_%' escape '\'
         or c.relname in (
           'audit_log',
           'folder_public_secrets',
           'live_visitors',
           'user_acquisition',
           'user_analytics_preferences',
           'visitor_traffic'
         )
       )
  loop
    if not exists (
      select 1
        from pg_policies
       where schemaname = 'public'
         and tablename = r.relname
         and policyname = 'deny_client_access'
    ) then
      execute format(
        'create policy deny_client_access on public.%I as restrictive for all to anon, authenticated using (false) with check (false)',
        r.relname
      );
    end if;
  end loop;
end
$$;

-- Current advisor findings: pin helper search paths and ensure the trigger
-- function cannot be invoked through the Data API.
alter function public.analytics_earliest(timestamptz, timestamptz)
  set search_path = public, pg_temp;
alter function public.analytics_resolve_activation(timestamptz, timestamptz)
  set search_path = public, pg_temp;
alter function public.folder_members_reject_owner()
  set search_path = public, pg_temp;
revoke all on function public.staff_guard_last_super_admin()
  from public, anon, authenticated;
