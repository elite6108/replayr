-- Client and Worker error groups for the admin console.
-- Writes go through the Worker (service role). Clients have no grants.

create table public.error_events (
  fingerprint text primary key,
  surface text not null check (surface in ('desktop', 'web', 'mobile', 'worker')),
  level text not null check (level in ('error', 'crash')),
  message text not null,
  stack text,
  release text,
  path text,
  count integer not null default 1 check (count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  sample_user_id uuid
);

create index error_events_open_idx on public.error_events (last_seen_at desc) where resolved_at is null;
create index error_events_surface_idx on public.error_events (surface, last_seen_at desc);

create or replace function public.ingest_error_event(
  p_fingerprint text,
  p_surface text,
  p_level text,
  p_message text,
  p_stack text,
  p_release text,
  p_path text,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.error_events (
    fingerprint, surface, level, message, stack, release, path, sample_user_id
  ) values (
    p_fingerprint, p_surface, p_level, p_message, p_stack, p_release, p_path, p_user_id
  )
  on conflict (fingerprint) do update set
    count = public.error_events.count + 1,
    last_seen_at = now(),
    stack = coalesce(nullif(excluded.stack, ''), public.error_events.stack),
    release = coalesce(excluded.release, public.error_events.release),
    path = coalesce(excluded.path, public.error_events.path),
    sample_user_id = coalesce(public.error_events.sample_user_id, excluded.sample_user_id),
    resolved_at = null;
end;
$$;

alter table public.error_events enable row level security;

revoke all on function public.ingest_error_event(text, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on table public.error_events from public, anon, authenticated;
grant execute on function public.ingest_error_event(text, text, text, text, text, text, text, uuid)
  to service_role;
grant select, insert, update, delete on table public.error_events to service_role;
