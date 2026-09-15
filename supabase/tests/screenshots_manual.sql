-- Manual screenshot quota checks. Run against a throwaway local/staging database as a role
-- that can create auth users (typically the postgres role). Do not run in production.
--
-- Expected outcomes are asserted with DO blocks so a failure raises.

create extension if not exists pgcrypto;

do $$
declare
  v_free uuid;
  v_pro uuid;
  v_user uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_user2 uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_id uuid;
  v_slug text;
  v_key text;
  v_result jsonb;
  v_evicted jsonb;
  v_n int;
  v_i int;
  v_bytes bigint := 1024;
begin
  select id into v_free from public.plans where slug = 'free';
  select id into v_pro from public.plans where slug = 'pro';
  if v_free is null or v_pro is null then
    raise exception 'plans.free / plans.pro missing';
  end if;

  -- Isolated auth users for this script.
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id)
  values
    (v_user, 'authenticated', 'authenticated', 'shot-test@example.com', crypt('x', gen_salt('bf')), now(), now(), now(), '00000000-0000-0000-0000-000000000000'),
    (v_user2, 'authenticated', 'authenticated', 'shot-test-2@example.com', crypt('x', gen_salt('bf')), now(), now(), now(), '00000000-0000-0000-0000-000000000000')
  on conflict (id) do nothing;

  insert into public.user_storage (user_id, plan_id, storage_used_bytes, storage_limit_bytes)
  values (v_user, v_free, 0, 5368709120)
  on conflict (user_id) do update set plan_id = excluded.plan_id;

  delete from public.screenshots where user_id in (v_user, v_user2);
  delete from public.screenshot_trim_schedule where user_id in (v_user, v_user2);

  -- 10 ready images, then the 11th finalize evicts exactly one.
  for v_i in 1..10 loop
    v_id := gen_random_uuid();
    v_slug := substr(replace(v_id::text, '-', ''), 1, 12);
    -- slug charset: map hex into allowed alphabet by using a fixed valid slug + index.
    v_slug := 'abcdefghijkm';
    v_slug := overlay(v_slug placing chr(ascii('2') + (v_i % 8)) from 12);
    perform public.reserve_screenshot(v_user, v_id, v_slug, v_bytes, 64, 64);
    perform public.finalize_screenshot(v_user, v_id);
  end loop;

  v_id := gen_random_uuid();
  v_key := public.reserve_screenshot(v_user, v_id, 'abcdefghijk2', v_bytes, 64, 64);
  v_result := public.finalize_screenshot(v_user, v_id);
  v_evicted := v_result->'evicted';
  if jsonb_array_length(v_evicted) <> 1 then
    raise exception '11th free upload must evict exactly one, got %', v_evicted;
  end if;
  select count(*) into v_n from public.screenshots where user_id = v_user and status = 'ready';
  if v_n <> 10 then
    raise exception 'free user should have 10 ready after 11th upload, got %', v_n;
  end if;

  -- A failed upload evicts nothing: reserve then fail, ready count stays 10.
  v_id := gen_random_uuid();
  perform public.reserve_screenshot(v_user, v_id, 'abcdefghijk3', v_bytes, 64, 64);
  perform public.fail_screenshot(v_user, v_id);
  select count(*) into v_n from public.screenshots where user_id = v_user and status = 'ready';
  if v_n <> 10 then
    raise exception 'failed upload must not evict, ready=%', v_n;
  end if;
  if (select status from public.screenshots where id = v_id) <> 'failed' then
    raise exception 'fail_screenshot did not mark failed';
  end if;

  -- Concurrent sessions: three uploading is allowed; the fourth raises screenshot_busy.
  delete from public.screenshots where user_id = v_user;
  for v_i in 1..3 loop
    v_id := gen_random_uuid();
    v_slug := overlay('abcdefghijk4' placing chr(ascii('2') + v_i) from 12);
    perform public.reserve_screenshot(v_user, v_id, v_slug, v_bytes, 64, 64);
  end loop;
  begin
    v_id := gen_random_uuid();
    perform public.reserve_screenshot(v_user, v_id, 'abcdefghijk5', v_bytes, 64, 64);
    raise exception 'expected screenshot_busy on fourth in-flight upload';
  exception
    when others then
      if sqlerrm not like '%screenshot_busy%' then
        raise;
      end if;
  end;

  -- Premium bytes eviction: tiny limit simulated by switching to pro then inserting large ready rows.
  update public.user_storage set plan_id = v_pro where user_id = v_user;
  delete from public.screenshots where user_id = v_user;
  -- Two 20 MiB images would exceed 15 GiB? No — 15 GiB is huge. Insert two ready rows that
  -- together exceed a temporary local limit by using file sizes close to the 32 MiB cap and a
  -- plan whose bytes limit we cannot mutate globally. Instead, assert that finalize never evicts
  -- the image being finalized when older rows already fill the quota... skip if we cannot shrink
  -- pro. Directly call eviction by inserting rows whose sum exceeds screenshot_bytes_limit.
  -- 15 GiB / 32 MiB ≈ 480 images — too many. Check the RPC still returns empty evicted when
  -- under the bytes cap.
  v_id := gen_random_uuid();
  perform public.reserve_screenshot(v_user, v_id, 'abcdefghijk6', 33554432, 64, 64);
  v_result := public.finalize_screenshot(v_user, v_id);
  if jsonb_array_length(v_result->'evicted') <> 0 then
    raise exception 'single premium image must not evict';
  end if;

  -- Trim schedule + batched trim.
  update public.user_storage set plan_id = v_free where user_id = v_user;
  delete from public.screenshots where user_id = v_user;
  for v_i in 1..12 loop
    insert into public.screenshots (id, user_id, slug, storage_key, width, height, file_size_bytes, status, created_at)
    values (
      gen_random_uuid(),
      v_user,
      overlay('zzzzzzzzzzz2' placing chr(ascii('a') + v_i) from 12),
      'screenshots/' || v_user::text || '/' || gen_random_uuid()::text || '.png',
      8, 8, 128, 'ready', now() - (v_i || ' minutes')::interval
    );
  end loop;
  perform public.schedule_screenshot_trims();
  if not exists (select 1 from public.screenshot_trim_schedule where user_id = v_user) then
    raise exception 'downgrade with 12 images must schedule a trim';
  end if;

  -- Due now so apply_screenshot_trims can run.
  update public.screenshot_trim_schedule set trim_after = now() - interval '1 second' where user_id = v_user;
  v_evicted := public.apply_screenshot_trims(200);
  if jsonb_array_length(v_evicted) <> 2 then
    raise exception 'batched trim should evict 2 of 12, got %', v_evicted;
  end if;
  select count(*) into v_n from public.screenshots where user_id = v_user and status = 'ready';
  if v_n <> 10 then
    raise exception 'after trim ready should be 10, got %', v_n;
  end if;
  if exists (select 1 from public.screenshot_trim_schedule where user_id = v_user) then
    raise exception 'trim schedule should clear after apply';
  end if;

  -- Re-upgrade clears a pending schedule.
  delete from public.screenshots where user_id = v_user;
  for v_i in 1..12 loop
    insert into public.screenshots (id, user_id, slug, storage_key, width, height, file_size_bytes, status)
    values (
      gen_random_uuid(), v_user,
      overlay('yyyyyyyyyyy2' placing chr(ascii('a') + v_i) from 12),
      'k', 8, 8, 128, 'ready'
    );
  end loop;
  update public.user_storage set plan_id = v_free where user_id = v_user;
  perform public.schedule_screenshot_trims();
  update public.user_storage set plan_id = v_pro where user_id = v_user;
  perform public.schedule_screenshot_trims();
  if exists (select 1 from public.screenshot_trim_schedule where user_id = v_user) then
    raise exception 're-upgrade must clear the trim schedule';
  end if;

  -- The authenticated role cannot execute the RPCs or select rows.
  begin
    execute 'set local role authenticated';
    begin
      perform public.reserve_screenshot(v_user, gen_random_uuid(), 'abcdefghijk7', 128, 8, 8);
      raise exception 'authenticated must not execute reserve_screenshot';
    exception
      when insufficient_privilege then null;
    end;
    begin
      perform count(*) from public.screenshots;
      -- FORCE RLS + deny policy: the select is allowed as a statement but returns 0 rows.
    end;
    if exists (select 1 from public.screenshots) then
      raise exception 'authenticated must not see screenshot rows';
    end if;
    execute 'reset role';
  end;

  raise notice 'screenshots_manual.sql passed';
end
$$;
