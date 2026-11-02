-- AI moment transcripts and the monthly allowance. Service role only.
-- The desktop never reads these tables. No audio is stored.

create table if not exists public.ai_transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
  duration_ms integer not null check (duration_ms > 0 and duration_ms <= 2700000),
  segments jsonb not null check (jsonb_typeof(segments) = 'array'),
  created_at timestamptz not null default now(),
  unique (user_id, audio_sha256)
);

create table if not exists public.ai_moment_cache (
  transcript_id uuid not null references public.ai_transcripts (id) on delete cascade,
  format text not null check (format in ('reel', 'youtube')),
  moments jsonb not null check (jsonb_typeof(moments) = 'array'),
  created_at timestamptz not null default now(),
  primary key (transcript_id, format)
);

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start date not null,
  transcribed_seconds integer not null default 0 check (transcribed_seconds >= 0 and transcribed_seconds <= 1000000),
  rankings integer not null default 0 check (rankings >= 0 and rankings <= 100000),
  primary key (user_id, period_start)
);

alter table public.ai_transcripts enable row level security;
alter table public.ai_transcripts force row level security;
alter table public.ai_moment_cache enable row level security;
alter table public.ai_moment_cache force row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;

drop policy if exists ai_transcripts_no_client on public.ai_transcripts;
create policy ai_transcripts_no_client on public.ai_transcripts
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists ai_moment_cache_no_client on public.ai_moment_cache;
create policy ai_moment_cache_no_client on public.ai_moment_cache
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists ai_usage_no_client on public.ai_usage;
create policy ai_usage_no_client on public.ai_usage
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table public.ai_transcripts from public, anon, authenticated;
revoke all on table public.ai_moment_cache from public, anon, authenticated;
revoke all on table public.ai_usage from public, anon, authenticated;
grant all on table public.ai_transcripts to service_role;
grant all on table public.ai_moment_cache to service_role;
grant all on table public.ai_usage to service_role;

create or replace function public.reserve_ai_seconds(p_user_id uuid, p_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_start date := date_trunc('month', timezone('utc', now()))::date;
  used integer;
begin
  if p_user_id is null or p_seconds is null or p_seconds <= 0 or p_seconds > 2700 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  insert into public.ai_usage (user_id, period_start)
  values (p_user_id, month_start)
  on conflict (user_id, period_start) do nothing;

  select transcribed_seconds
    into used
    from public.ai_usage
   where user_id = p_user_id
     and period_start = month_start
   for update;

  if used + p_seconds > 5400 then
    raise exception 'Monthly transcription limit reached.' using errcode = 'P0001';
  end if;

  update public.ai_usage
     set transcribed_seconds = transcribed_seconds + p_seconds
   where user_id = p_user_id
     and period_start = month_start;

  return used + p_seconds;
end;
$$;

create or replace function public.refund_ai_seconds(p_user_id uuid, p_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_start date := date_trunc('month', timezone('utc', now()))::date;
  used integer;
begin
  if p_user_id is null or p_seconds is null or p_seconds <= 0 or p_seconds > 2700 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  update public.ai_usage
     set transcribed_seconds = greatest(0, transcribed_seconds - p_seconds)
   where user_id = p_user_id
     and period_start = month_start
  returning transcribed_seconds into used;

  return coalesce(used, 0);
end;
$$;

-- Records seconds already spent at OpenAI when the file ran slightly past the reservation.
create or replace function public.note_ai_seconds(p_user_id uuid, p_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_start date := date_trunc('month', timezone('utc', now()))::date;
  used integer;
begin
  if p_user_id is null or p_seconds is null or p_seconds <= 0 or p_seconds > 2700 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  insert into public.ai_usage (user_id, period_start)
  values (p_user_id, month_start)
  on conflict (user_id, period_start) do nothing;

  update public.ai_usage
     set transcribed_seconds = least(1000000, transcribed_seconds + p_seconds)
   where user_id = p_user_id
     and period_start = month_start
  returning transcribed_seconds into used;

  return coalesce(used, 0);
end;
$$;

create or replace function public.reserve_ai_ranking(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_start date := date_trunc('month', timezone('utc', now()))::date;
  used integer;
begin
  if p_user_id is null then
    raise exception 'invalid user' using errcode = '22023';
  end if;

  insert into public.ai_usage (user_id, period_start)
  values (p_user_id, month_start)
  on conflict (user_id, period_start) do nothing;

  select rankings
    into used
    from public.ai_usage
   where user_id = p_user_id
     and period_start = month_start
   for update;

  if used + 1 > 60 then
    raise exception 'Monthly moment limit reached.' using errcode = 'P0001';
  end if;

  update public.ai_usage
     set rankings = rankings + 1
   where user_id = p_user_id
     and period_start = month_start;

  return used + 1;
end;
$$;

create or replace function public.refund_ai_ranking(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  month_start date := date_trunc('month', timezone('utc', now()))::date;
  used integer;
begin
  if p_user_id is null then
    raise exception 'invalid user' using errcode = '22023';
  end if;

  update public.ai_usage
     set rankings = greatest(0, rankings - 1)
   where user_id = p_user_id
     and period_start = month_start
  returning rankings into used;

  return coalesce(used, 0);
end;
$$;

revoke all on function public.reserve_ai_seconds(uuid, integer) from public, anon, authenticated;
revoke all on function public.refund_ai_seconds(uuid, integer) from public, anon, authenticated;
revoke all on function public.note_ai_seconds(uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_ai_ranking(uuid) from public, anon, authenticated;
revoke all on function public.refund_ai_ranking(uuid) from public, anon, authenticated;
grant execute on function public.reserve_ai_seconds(uuid, integer) to service_role;
grant execute on function public.refund_ai_seconds(uuid, integer) to service_role;
grant execute on function public.note_ai_seconds(uuid, integer) to service_role;
grant execute on function public.reserve_ai_ranking(uuid) to service_role;
grant execute on function public.refund_ai_ranking(uuid) to service_role;
