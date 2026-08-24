-- Daily view totals so Featured can rank public clips by watches today.
-- Writes go through the Worker (service role). Clients have no grants.

create table public.clip_daily_views (
  clip_id uuid not null references public.clips (id) on delete cascade,
  day date not null default (timezone('utc', now()))::date,
  count integer not null default 1 check (count > 0),
  primary key (clip_id, day)
);

create index clip_daily_views_day_idx on public.clip_daily_views (day, count desc);

create or replace function public.record_clip_view(p_clip_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.clips
    set view_count = view_count + 1
    where id = p_clip_id
      and status = 'ready'
      and visibility in ('public', 'unlisted');
  if not found then
    return;
  end if;

  insert into public.clip_daily_views (clip_id, day, count)
  values (p_clip_id, (timezone('utc', now()))::date, 1)
  on conflict (clip_id, day) do update
    set count = public.clip_daily_views.count + 1;
end;
$$;

alter table public.clip_daily_views enable row level security;

revoke all on function public.record_clip_view(uuid) from public, anon, authenticated;
revoke all on table public.clip_daily_views from public, anon, authenticated;
grant execute on function public.record_clip_view(uuid) to service_role;
grant select, insert, update, delete on table public.clip_daily_views to service_role;
