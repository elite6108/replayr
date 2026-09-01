-- Phase A product analytics. Separate from product_events and folder_activity.
-- Service role + security-definer ingest only. No authenticated SELECT or INSERT.

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text unique,
  user_id uuid,
  anonymous_id text,
  session_id text,
  event_name text not null,
  event_version integer not null default 1,
  platform text,
  app_version text,
  os text,
  device_type text,
  environment text not null,
  properties jsonb not null default '{}'::jsonb,
  acquisition_source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  country_code text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  constraint analytics_events_environment_check
    check (environment in ('production', 'development')),
  constraint analytics_events_name_check
    check (char_length(event_name) between 1 and 80),
  constraint analytics_events_version_check
    check (event_version >= 1),
  constraint analytics_events_country_check
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint analytics_events_properties_size_check
    check (octet_length(properties::text) <= 8192),
  constraint analytics_events_idempotency_key_len
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 160)
);

create index if not exists analytics_events_name_occurred_idx
  on public.analytics_events (event_name, occurred_at desc);

create index if not exists analytics_events_user_occurred_idx
  on public.analytics_events (user_id, occurred_at desc)
  where user_id is not null;

create index if not exists analytics_events_production_occurred_idx
  on public.analytics_events (occurred_at desc)
  where environment = 'production';

alter table public.analytics_events enable row level security;
alter table public.analytics_events force row level security;

revoke all on table public.analytics_events from public, anon, authenticated;
grant select, insert on table public.analytics_events to service_role;

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
  p_occurred_at timestamptz
)
returns table (inserted boolean, event_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_inserted boolean := false;
begin
  if p_event_name is null or length(trim(p_event_name)) = 0 then
    raise exception 'invalid analytics event name';
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
    occurred_at
  ) values (
    coalesce(p_id, gen_random_uuid()),
    nullif(trim(p_idempotency_key), ''),
    p_user_id,
    nullif(trim(p_anonymous_id), ''),
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
    coalesce(p_occurred_at, now())
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
  text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.ingest_analytics_event(
  uuid, text, uuid, text, text, text, integer, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, text, timestamptz
) to service_role;

-- Observational signup hook. Must never fail account creation.
create or replace function public.emit_signup_analytics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
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
      'production',
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

revoke all on function public.emit_signup_analytics() from public, anon, authenticated;
grant execute on function public.emit_signup_analytics() to supabase_auth_admin;

drop trigger if exists on_auth_user_created_analytics on auth.users;
create trigger on_auth_user_created_analytics
  after insert on auth.users
  for each row execute function public.emit_signup_analytics();
