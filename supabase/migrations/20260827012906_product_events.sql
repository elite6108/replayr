-- Lightweight product metrics (upload success, compose_ms, sign_count, …).
-- Service role only; Worker inserts via ingest_product_event.

create table if not exists public.product_events (
  id bigserial primary key,
  name text not null,
  value double precision,
  dims jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists product_events_name_created_idx
  on public.product_events (name, created_at desc);

alter table public.product_events enable row level security;

revoke all on table public.product_events from anon, authenticated;
grant select, insert on table public.product_events to service_role;
grant usage, select on sequence public.product_events_id_seq to service_role;

create or replace function public.ingest_product_event(
  p_name text,
  p_value double precision default null,
  p_dims jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_name is null or length(trim(p_name)) = 0 or length(p_name) > 64 then
    raise exception 'invalid product event name';
  end if;
  insert into public.product_events (name, value, dims)
  values (trim(p_name), p_value, coalesce(p_dims, '{}'::jsonb));
end;
$$;

revoke all on function public.ingest_product_event(text, double precision, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_product_event(text, double precision, jsonb) to service_role;
