-- Cloud screenshots. Limits live on plans and are joined through user_storage.plan_id so the
-- new-user trigger in init.sql cannot fail open to unlimited. Rows are never hard-deleted by
-- product RPCs (old /s/{slug} links must 404, never show someone else's image).

alter table public.plans
  add column if not exists screenshot_count_limit integer,
  add column if not exists screenshot_bytes_limit bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'plans_screenshot_count_limit_positive'
  ) then
    alter table public.plans
      add constraint plans_screenshot_count_limit_positive
      check (screenshot_count_limit is null or screenshot_count_limit > 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'plans_screenshot_bytes_limit_positive'
  ) then
    alter table public.plans
      add constraint plans_screenshot_bytes_limit_positive
      check (screenshot_bytes_limit is null or screenshot_bytes_limit > 0);
  end if;
end
$$;

-- Free: rolling 10 images. Premium: rolling 15 GiB. Null means that axis is not enforced.
update public.plans
   set screenshot_count_limit = 10,
       screenshot_bytes_limit = null
 where slug = 'free';

update public.plans
   set screenshot_count_limit = null,
       screenshot_bytes_limit = 16106127360
 where slug in ('pro', 'pro_plus');

create table if not exists public.screenshots (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-km-z2-9]{12}$'),
  storage_key text,
  width integer not null check (width >= 1 and width <= 16384),
  height integer not null check (height >= 1 and height <= 16384),
  file_size_bytes bigint not null check (file_size_bytes >= 67 and file_size_bytes <= 33554432),
  status text not null check (status in ('uploading', 'ready', 'failed', 'deleted')),
  deleted_reason text check (
    deleted_reason is null
    or deleted_reason in ('user', 'evicted', 'downgrade', 'abuse', 'account')
  ),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  deleted_at timestamptz,
  check (width::bigint * height::bigint <= 50000000)
);

create index if not exists screenshots_live_user_created_idx
  on public.screenshots (user_id, created_at, id)
  where status = 'ready';

create index if not exists screenshots_uploading_created_idx
  on public.screenshots (created_at)
  where status = 'uploading';

create index if not exists screenshots_purge_candidates_idx
  on public.screenshots (created_at)
  where status in ('failed', 'deleted') and storage_key is not null;

-- Separate from user_storage so a 30-day downgrade grace does not alter clip quota columns.
create table if not exists public.screenshot_trim_schedule (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trim_after timestamptz not null
);

alter table public.screenshots enable row level security;
alter table public.screenshots force row level security;
alter table public.screenshot_trim_schedule enable row level security;
alter table public.screenshot_trim_schedule force row level security;

drop policy if exists screenshots_no_client on public.screenshots;
create policy screenshots_no_client on public.screenshots
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists screenshot_trim_schedule_no_client on public.screenshot_trim_schedule;
create policy screenshot_trim_schedule_no_client on public.screenshot_trim_schedule
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table public.screenshots from public, anon, authenticated;
revoke all on table public.screenshot_trim_schedule from public, anon, authenticated;
grant all on table public.screenshots to service_role;
grant all on table public.screenshot_trim_schedule to service_role;

-- ---------------------------------------------------------------------------
-- RPCs. Each locks the user's user_storage row so concurrent uploads serialize.
-- EXECUTE is service_role only — PostgREST with the user JWT must not reach these.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_screenshot(
  p_user_id uuid,
  p_id uuid,
  p_slug text,
  p_bytes bigint,
  p_width integer,
  p_height integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_storage public.user_storage%rowtype;
  v_plan public.plans%rowtype;
  v_uploading integer;
  v_key text;
begin
  if p_user_id is null or p_id is null or p_slug is null or p_bytes is null or p_width is null or p_height is null then
    raise exception 'invalid screenshot reserve' using errcode = '22023';
  end if;
  if p_slug !~ '^[a-km-z2-9]{12}$' then
    raise exception 'invalid screenshot slug' using errcode = '22023';
  end if;
  if p_bytes < 67 or p_bytes > 33554432 or p_width < 1 or p_width > 16384 or p_height < 1 or p_height > 16384
     or (p_width::bigint * p_height::bigint) > 50000000 then
    raise exception 'screenshot_too_large' using errcode = 'P0001';
  end if;

  select * into v_storage from public.user_storage where user_id = p_user_id for update;
  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  select * into v_plan from public.plans where id = v_storage.plan_id;
  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  -- Bytes limit is a hard cap on a single object. Eviction of older images happens at finalize
  -- so a failed upload never deletes the user's oldest screenshot.
  if v_plan.screenshot_bytes_limit is not null and p_bytes > v_plan.screenshot_bytes_limit then
    raise exception 'screenshot_too_large' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_uploading
    from public.screenshots
   where user_id = p_user_id and status = 'uploading';
  if v_uploading >= 3 then
    raise exception 'screenshot_busy' using errcode = 'P0001';
  end if;

  v_key := 'screenshots/' || p_user_id::text || '/' || p_id::text || '.png';

  insert into public.screenshots (
    id, user_id, slug, storage_key, width, height, file_size_bytes, status
  ) values (
    p_id, p_user_id, p_slug, v_key, p_width, p_height, p_bytes, 'uploading'
  );

  return v_key;
end;
$$;

create or replace function public.finalize_screenshot(p_user_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_storage public.user_storage%rowtype;
  v_plan public.plans%rowtype;
  v_row public.screenshots%rowtype;
  v_trim timestamptz;
  v_count bigint;
  v_bytes bigint;
  v_evicted jsonb := '[]'::jsonb;
  v_victim public.screenshots%rowtype;
  v_grace_count_evicted boolean := false;
begin
  if p_user_id is null or p_id is null then
    raise exception 'invalid screenshot finalize' using errcode = '22023';
  end if;

  select * into v_storage from public.user_storage where user_id = p_user_id for update;
  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;
  select * into v_plan from public.plans where id = v_storage.plan_id;

  select * into v_row
    from public.screenshots
   where id = p_id and user_id = p_user_id
   for update;
  if not found or v_row.status <> 'uploading' then
    raise exception 'screenshot not uploading' using errcode = 'P0002';
  end if;

  update public.screenshots
     set status = 'ready',
         ready_at = now()
   where id = p_id;

  select trim_after into v_trim
    from public.screenshot_trim_schedule
   where user_id = p_user_id;

  select count(*), coalesce(sum(file_size_bytes), 0)
    into v_count, v_bytes
    from public.screenshots
   where user_id = p_user_id and status = 'ready';

  -- Count plans (free): drop oldest ready rows until at/under the limit. During the 30-day
  -- downgrade grace a trim is scheduled, so each upload may evict at most one — never a mass
  -- delete on save.
  if v_plan.screenshot_count_limit is not null then
    while v_count > v_plan.screenshot_count_limit loop
      if v_trim is not null and v_grace_count_evicted then
        exit;
      end if;
      select * into v_victim
        from public.screenshots
       where user_id = p_user_id and status = 'ready' and id <> p_id
       order by created_at asc, id asc
       limit 1;
      exit when not found;
      update public.screenshots
         set status = 'deleted',
             deleted_reason = 'evicted',
             deleted_at = now()
       where id = v_victim.id;
      v_evicted := v_evicted || jsonb_build_array(jsonb_build_object(
        'id', v_victim.id,
        'key', v_victim.storage_key
      ));
      v_count := v_count - 1;
      v_bytes := v_bytes - v_victim.file_size_bytes;
      v_grace_count_evicted := true;
    end loop;
  end if;

  -- Bytes plans (premium): evict oldest until the new image fits. Failed uploads never reach here.
  if v_plan.screenshot_bytes_limit is not null then
    while v_bytes > v_plan.screenshot_bytes_limit loop
      select * into v_victim
        from public.screenshots
       where user_id = p_user_id and status = 'ready' and id <> p_id
       order by created_at asc, id asc
       limit 1;
      exit when not found;
      update public.screenshots
         set status = 'deleted',
             deleted_reason = 'evicted',
             deleted_at = now()
       where id = v_victim.id;
      v_evicted := v_evicted || jsonb_build_array(jsonb_build_object(
        'id', v_victim.id,
        'key', v_victim.storage_key
      ));
      v_count := v_count - 1;
      v_bytes := v_bytes - v_victim.file_size_bytes;
    end loop;
  end if;

  return jsonb_build_object(
    'slug', v_row.slug,
    'width', v_row.width,
    'height', v_row.height,
    'evicted', v_evicted,
    'usage', jsonb_build_object('count', v_count, 'bytes', v_bytes),
    'limits', jsonb_build_object(
      'count', v_plan.screenshot_count_limit,
      'bytes', v_plan.screenshot_bytes_limit
    ),
    'trimAfter', v_trim
  );
end;
$$;

create or replace function public.fail_screenshot(p_user_id uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_id is null then
    raise exception 'invalid screenshot fail' using errcode = '22023';
  end if;
  perform 1 from public.user_storage where user_id = p_user_id for update;
  update public.screenshots
     set status = 'failed'
   where id = p_id
     and user_id = p_user_id
     and status = 'uploading';
end;
$$;

create or replace function public.delete_screenshot(p_user_id uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if p_user_id is null or p_id is null then
    raise exception 'invalid screenshot delete' using errcode = '22023';
  end if;
  perform 1 from public.user_storage where user_id = p_user_id for update;
  update public.screenshots
     set status = 'deleted',
         deleted_reason = 'user',
         deleted_at = now()
   where id = p_id
     and user_id = p_user_id
     and status in ('ready', 'failed', 'uploading')
  returning storage_key into v_key;
  if not found then
    raise exception 'screenshot not found' using errcode = 'P0002';
  end if;
  return v_key;
end;
$$;

create or replace function public.screenshot_usage_for(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_storage public.user_storage%rowtype;
  v_plan public.plans%rowtype;
  v_count bigint;
  v_bytes bigint;
  v_trim timestamptz;
begin
  if p_user_id is null then
    raise exception 'invalid screenshot usage' using errcode = '22023';
  end if;
  select * into v_storage from public.user_storage where user_id = p_user_id for update;
  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;
  select * into v_plan from public.plans where id = v_storage.plan_id;
  select count(*), coalesce(sum(file_size_bytes), 0)
    into v_count, v_bytes
    from public.screenshots
   where user_id = p_user_id and status = 'ready';
  select trim_after into v_trim from public.screenshot_trim_schedule where user_id = p_user_id;
  return jsonb_build_object(
    'count', v_count,
    'bytes', v_bytes,
    'countLimit', v_plan.screenshot_count_limit,
    'bytesLimit', v_plan.screenshot_bytes_limit,
    'trimAfter', v_trim
  );
end;
$$;

-- Compare-and-set: only clear the key we just deleted from R2 so a later overwrite cannot be
-- blanked by a delayed sweep.
create or replace function public.mark_screenshot_purged(p_id uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_id is null or p_key is null or p_key = '' then
    return false;
  end if;
  update public.screenshots
     set storage_key = null
   where id = p_id
     and storage_key = p_key
     and status in ('failed', 'deleted');
  return found;
end;
$$;

-- Free-plan users who already have more ready images than the count limit (a premium leftover)
-- get 30 days before a batched trim. Existing schedules are left alone.
create or replace function public.schedule_screenshot_trims()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  -- Re-upgraded users (no count limit) must not keep a pending trim hanging over them.
  delete from public.screenshot_trim_schedule s
   using public.user_storage us
   join public.plans p on p.id = us.plan_id
   where s.user_id = us.user_id
     and p.screenshot_count_limit is null;

  insert into public.screenshot_trim_schedule (user_id, trim_after)
  select us.user_id, now() + interval '30 days'
    from public.user_storage us
    join public.plans p on p.id = us.plan_id
   where p.screenshot_count_limit is not null
     and not exists (
       select 1 from public.screenshot_trim_schedule existing where existing.user_id = us.user_id
     )
     and (
       select count(*) from public.screenshots sh
        where sh.user_id = us.user_id and sh.status = 'ready'
     ) > p.screenshot_count_limit
  on conflict (user_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.apply_screenshot_trims(p_batch integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_batch, 200), 200));
  v_user uuid;
  v_plan public.plans%rowtype;
  v_count bigint;
  v_victim public.screenshots%rowtype;
  v_evicted jsonb := '[]'::jsonb;
begin
  for v_user in
    select s.user_id
      from public.screenshot_trim_schedule s
     where s.trim_after <= now()
     order by s.trim_after asc
     limit v_limit
  loop
    perform 1 from public.user_storage where user_id = v_user for update;
    select p.* into v_plan
      from public.user_storage us
      join public.plans p on p.id = us.plan_id
     where us.user_id = v_user;
    if v_plan.screenshot_count_limit is null then
      delete from public.screenshot_trim_schedule where user_id = v_user;
      continue;
    end if;

    select count(*) into v_count
      from public.screenshots
     where user_id = v_user and status = 'ready';

    while v_count > v_plan.screenshot_count_limit loop
      select * into v_victim
        from public.screenshots
       where user_id = v_user and status = 'ready'
       order by created_at asc, id asc
       limit 1;
      exit when not found;
      update public.screenshots
         set status = 'deleted',
             deleted_reason = 'downgrade',
             deleted_at = now()
       where id = v_victim.id;
      v_evicted := v_evicted || jsonb_build_array(jsonb_build_object(
        'id', v_victim.id,
        'key', v_victim.storage_key,
        'userId', v_user
      ));
      v_count := v_count - 1;
    end loop;

    delete from public.screenshot_trim_schedule where user_id = v_user;
  end loop;

  return v_evicted;
end;
$$;

revoke all on function public.reserve_screenshot(uuid, uuid, text, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.finalize_screenshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_screenshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_screenshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.screenshot_usage_for(uuid) from public, anon, authenticated;
revoke all on function public.mark_screenshot_purged(uuid, text) from public, anon, authenticated;
revoke all on function public.schedule_screenshot_trims() from public, anon, authenticated;
revoke all on function public.apply_screenshot_trims(integer) from public, anon, authenticated;

grant execute on function public.reserve_screenshot(uuid, uuid, text, bigint, integer, integer) to service_role;
grant execute on function public.finalize_screenshot(uuid, uuid) to service_role;
grant execute on function public.fail_screenshot(uuid, uuid) to service_role;
grant execute on function public.delete_screenshot(uuid, uuid) to service_role;
grant execute on function public.screenshot_usage_for(uuid) to service_role;
grant execute on function public.mark_screenshot_purged(uuid, text) to service_role;
grant execute on function public.schedule_screenshot_trims() to service_role;
grant execute on function public.apply_screenshot_trims(integer) to service_role;
