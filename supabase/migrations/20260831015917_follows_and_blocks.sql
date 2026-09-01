-- Single follow graph + dedicated blocks.
-- public.friendships is copied, not dropped. Phase 3 retires it after verification.

create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (follower_id, following_id),
  check (follower_id <> following_id),
  check (status <> 'accepted' or accepted_at is not null),
  check (status <> 'pending' or accepted_at is null)
);

create index follows_following_id_idx on public.follows (following_id);
create index follows_follower_id_idx on public.follows (follower_id);
create index follows_pending_incoming_idx
  on public.follows (following_id, created_at desc)
  where status = 'pending';

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocks_blocked_id_idx on public.blocks (blocked_id);

insert into public.follows (follower_id, following_id, status, created_at, accepted_at)
select f.user_a, f.user_b, 'accepted', f.created_at, coalesce(f.updated_at, f.created_at)
from public.friendships f
where f.status = 'accepted'
union all
select f.user_b, f.user_a, 'accepted', f.created_at, coalesce(f.updated_at, f.created_at)
from public.friendships f
where f.status = 'accepted';

insert into public.follows (follower_id, following_id, status, created_at, accepted_at)
select
  f.requested_by,
  case when f.requested_by = f.user_a then f.user_b else f.user_a end,
  'pending',
  f.created_at,
  null
from public.friendships f
where f.status = 'pending';

insert into public.blocks (blocker_id, blocked_id, created_at)
select
  f.blocked_by,
  case when f.blocked_by = f.user_a then f.user_b else f.user_a end,
  f.created_at
from public.friendships f
where f.status = 'blocked'
  and f.blocked_by is not null;

alter table public.follows enable row level security;
alter table public.follows force row level security;
alter table public.blocks enable row level security;
alter table public.blocks force row level security;

create policy follows_select on public.follows
  for select using (
    follower_id = (select auth.uid())
    or following_id = (select auth.uid())
  );

create policy blocks_select on public.blocks
  for select using (
    blocker_id = (select auth.uid())
    or blocked_id = (select auth.uid())
  );

revoke all on table public.follows from anon, authenticated;
revoke all on table public.blocks from anon, authenticated;
grant select on table public.follows to authenticated;
grant select on table public.blocks to authenticated;
grant select, insert, update, delete on table public.follows to service_role;
grant select, insert, update, delete on table public.blocks to service_role;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in (
    'friend_request',
    'friend_accept',
    'follow_request',
    'follow_accept',
    'message',
    'group_invite'
  ));

do $$
declare
  missing_accepted integer;
  missing_pending integer;
  extra_pending integer;
  missing_blocks integer;
begin
  select count(*) into missing_accepted
  from public.friendships f
  where f.status = 'accepted'
    and (
      not exists (
        select 1 from public.follows x
        where x.follower_id = f.user_a
          and x.following_id = f.user_b
          and x.status = 'accepted'
      )
      or not exists (
        select 1 from public.follows x
        where x.follower_id = f.user_b
          and x.following_id = f.user_a
          and x.status = 'accepted'
      )
    );

  select count(*) into missing_pending
  from public.friendships f
  where f.status = 'pending'
    and not exists (
      select 1 from public.follows x
      where x.follower_id = f.requested_by
        and x.following_id = case when f.requested_by = f.user_a then f.user_b else f.user_a end
        and x.status = 'pending'
    );

  select count(*) into extra_pending
  from public.friendships f
  where f.status = 'pending'
    and (
      select count(*)
      from public.follows x
      where x.follower_id = f.requested_by
        and x.following_id = case when f.requested_by = f.user_a then f.user_b else f.user_a end
        and x.status = 'pending'
    ) <> 1;

  select count(*) into missing_blocks
  from public.friendships f
  where f.status = 'blocked'
    and f.blocked_by is not null
    and not exists (
      select 1 from public.blocks b
      where b.blocker_id = f.blocked_by
        and b.blocked_id = case when f.blocked_by = f.user_a then f.user_b else f.user_a end
    );

  if missing_accepted > 0 or missing_pending > 0 or extra_pending > 0 or missing_blocks > 0 then
    raise exception
      'follow migration pair check failed: missing_accepted=% missing_pending=% extra_pending=% missing_blocks=%',
      missing_accepted, missing_pending, extra_pending, missing_blocks;
  end if;

  if (
    (select count(*) from public.follows where status = 'accepted')
    <> (select count(*) from public.friendships where status = 'accepted') * 2
  ) then
    raise exception 'follow migration count check failed: accepted follows must be 2x accepted friendships';
  end if;

  if (
    (select count(*) from public.follows where status = 'pending')
    <> (select count(*) from public.friendships where status = 'pending')
  ) then
    raise exception 'follow migration count check failed: pending follows must equal pending friendships';
  end if;

  if (
    (select count(*) from public.blocks)
    <> (select count(*) from public.friendships where status = 'blocked' and blocked_by is not null)
  ) then
    raise exception 'follow migration count check failed: blocks must equal blocked friendships';
  end if;
end;
$$;
