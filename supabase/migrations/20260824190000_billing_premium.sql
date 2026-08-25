-- Replayr Premium: Stripe billing, plan feature flags, complimentary grants.

alter table public.plans
  add column if not exists watermark boolean not null default false,
  add column if not exists ads boolean not null default false;

update public.plans
   set max_clip_duration_ms = 1200000,
       max_upload_quality = '1080p',
       watermark = true,
       ads = true
 where slug = 'free';

update public.plans
   set max_clip_duration_ms = null,
       max_upload_quality = 'original',
       watermark = false,
       ads = false
 where slug = 'pro';

update public.plans
   set max_clip_duration_ms = null,
       max_upload_quality = 'original',
       watermark = false,
       ads = false
 where slug = 'pro_plus';

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  user_id uuid references auth.users (id) on delete set null,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_slug text not null,
  reason text,
  granted_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  watermark_enabled boolean not null default true,
  ads_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, watermark_enabled, ads_enabled)
values (1, true, true)
on conflict (id) do nothing;

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.stripe_events enable row level security;
alter table public.billing_grants enable row level security;
alter table public.app_settings enable row level security;

create policy billing_customers_select on public.billing_customers
  for select using (user_id = auth.uid());

create policy billing_subscriptions_select on public.billing_subscriptions
  for select using (user_id = auth.uid());

create policy billing_grants_select on public.billing_grants
  for select using (user_id = auth.uid());

create policy app_settings_read on public.app_settings for select using (true);

revoke all on table public.billing_customers from anon, authenticated;
revoke all on table public.billing_subscriptions from anon, authenticated;
revoke all on table public.stripe_events from anon, authenticated;
revoke all on table public.billing_grants from anon, authenticated;
revoke all on table public.app_settings from anon, authenticated;
grant select on table public.billing_customers to authenticated;
grant select on table public.billing_subscriptions to authenticated;
grant select on table public.billing_grants to authenticated;
grant select on table public.app_settings to anon, authenticated;

create or replace function public.apply_user_plan(p_user_id uuid, p_slug text, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_plan public.plans%rowtype;
  active_grant public.billing_grants%rowtype;
begin
  if p_user_id is null or p_slug is null or p_slug not in ('free', 'pro', 'pro_plus') then
    raise exception 'Unknown plan.' using errcode = '22023';
  end if;

  if not coalesce(p_force, false) and p_slug = 'free' then
    select *
      into active_grant
      from public.billing_grants
     where user_id = p_user_id
       and revoked_at is null
       and (expires_at is null or expires_at > now())
     order by created_at desc
     limit 1;
    if found then
      return;
    end if;
  end if;

  select * into strict next_plan from public.plans where slug = p_slug;

  update public.user_storage
     set plan_id = next_plan.id,
         storage_limit_bytes = next_plan.storage_limit_bytes,
         updated_at = now()
   where user_id = p_user_id;

  if not found then
    insert into public.user_storage (user_id, plan_id, storage_used_bytes, storage_limit_bytes)
    values (p_user_id, next_plan.id, 0, next_plan.storage_limit_bytes);
  end if;
end;
$$;

revoke all on function public.apply_user_plan(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_user_plan(uuid, text, boolean) to service_role;

create or replace function public.add_storage_used_for(p_user_id uuid, p_bytes bigint)
returns table(storage_used_bytes bigint, storage_limit_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  current public.user_storage%rowtype;
begin
  if p_user_id is null or p_bytes is null or p_bytes < 0 or p_bytes > 53687091200 then
    raise exception 'invalid size' using errcode = '22023';
  end if;

  select *
    into current
    from public.user_storage
   where user_id = p_user_id
   for update;

  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  if current.storage_used_bytes + p_bytes > current.storage_limit_bytes then
    raise exception 'This clip would exceed your cloud storage limit.' using errcode = 'P0001';
  end if;

  return query
    update public.user_storage
       set storage_used_bytes = public.user_storage.storage_used_bytes + p_bytes
     where user_id = p_user_id
     returning public.user_storage.storage_used_bytes, public.user_storage.storage_limit_bytes;
end;
$$;

create or replace function public.release_storage_used_for(p_user_id uuid, p_bytes bigint)
returns table(storage_used_bytes bigint, storage_limit_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  current public.user_storage%rowtype;
begin
  if p_user_id is null or p_bytes is null or p_bytes < 0 or p_bytes > 53687091200 then
    raise exception 'invalid size' using errcode = '22023';
  end if;

  select *
    into current
    from public.user_storage
   where user_id = p_user_id
   for update;

  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  return query
    update public.user_storage
       set storage_used_bytes = greatest(0, public.user_storage.storage_used_bytes - p_bytes)
     where user_id = p_user_id
     returning public.user_storage.storage_used_bytes, public.user_storage.storage_limit_bytes;
end;
$$;
