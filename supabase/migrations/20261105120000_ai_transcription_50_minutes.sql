-- Monthly AI transcription cap is 50 minutes (3000 seconds). The worker
-- constant TRANSCRIPTION_LIMIT_SECONDS must stay in step with this check.

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

  if used + p_seconds > 3000 then
    raise exception 'Monthly transcription limit reached.' using errcode = 'P0001';
  end if;

  update public.ai_usage
     set transcribed_seconds = transcribed_seconds + p_seconds
   where user_id = p_user_id
     and period_start = month_start;

  return used + p_seconds;
end;
$$;

revoke all on function public.reserve_ai_seconds(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_seconds(uuid, integer) to service_role;
