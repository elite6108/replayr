-- Mutual friends, 1:1 DMs, group chats, private clip grants, notifications.
-- Writes go through the Worker (service role). Clients have SELECT only so
-- Realtime can subscribe to messages/notifications after auth.

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  blocked_by uuid references public.profiles (id) on delete set null,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_a < user_b),
  check (user_a <> user_b),
  check (requested_by in (user_a, user_b)),
  check (blocked_by is null or blocked_by in (user_a, user_b)),
  check (status <> 'blocked' or blocked_by is not null),
  unique (user_a, user_b)
);

create index friendships_user_a_status_idx on public.friendships (user_a, status);
create index friendships_user_b_status_idx on public.friendships (user_b, status);
create index friendships_pending_idx on public.friendships (requested_by, created_at desc)
  where status = 'pending';

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('dm', 'group')),
  title text check (title is null or char_length(title) between 1 and 64),
  avatar_url text,
  created_by uuid not null references public.profiles (id) on delete cascade,
  dm_user_a uuid references public.profiles (id) on delete cascade,
  dm_user_b uuid references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      type = 'dm'
      and dm_user_a is not null
      and dm_user_b is not null
      and dm_user_a < dm_user_b
    )
    or (
      type = 'group'
      and dm_user_a is null
      and dm_user_b is null
    )
  )
);

create unique index conversations_dm_pair_idx
  on public.conversations (dm_user_a, dm_user_b)
  where type = 'dm';

create index conversations_updated_idx on public.conversations (updated_at desc);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx
  on public.conversation_members (user_id, conversation_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text check (body is null or char_length(body) between 1 and 2000),
  clip_id uuid references public.clips (id) on delete set null,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc, id desc);

create table public.conversation_clips (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  clip_id uuid not null references public.clips (id) on delete cascade,
  granted_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, clip_id)
);

create index conversation_clips_clip_idx on public.conversation_clips (clip_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('friend_request', 'friend_accept', 'message', 'group_invite')),
  actor_id uuid references public.profiles (id) on delete set null,
  friendship_id uuid references public.friendships (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

create or replace function public.enforce_conversation_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n
  from public.conversation_members
  where conversation_id = new.conversation_id;
  if n >= 32 then
    raise exception 'Conversation is full.';
  end if;
  return new;
end;
$$;

create trigger conversation_members_limit
before insert on public.conversation_members
for each row execute function public.enforce_conversation_member_limit();

create trigger friendships_updated_at
before update on public.friendships
for each row execute function public.set_updated_at();

create trigger conversations_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
    set updated_at = now()
    where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
after insert on public.messages
for each row execute function public.touch_conversation_on_message();

create or replace function public.get_clip_for_playback(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  duration_ms integer,
  width integer,
  height integer,
  visibility text,
  status text,
  storage_key text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{6,16}$' then
    return;
  end if;

  return query
    select
      c.id,
      c.slug,
      c.title,
      c.duration_ms,
      c.width,
      c.height,
      c.visibility,
      c.status,
      c.storage_key
    from public.clips c
    where c.slug = p_slug
      and c.status = 'ready'
      and c.storage_key is not null
      and (
        c.visibility in ('public', 'unlisted')
        or (c.visibility = 'private' and c.user_id = (select auth.uid()))
        or exists (
          select 1
          from public.conversation_clips cc
          join public.conversation_members cm
            on cm.conversation_id = cc.conversation_id
          where cc.clip_id = c.id
            and cm.user_id = (select auth.uid())
        )
      )
    limit 1;
end;
$$;

alter table public.friendships enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_clips enable row level security;
alter table public.notifications enable row level security;

create policy friendships_select on public.friendships
  for select using (
    user_a = (select auth.uid())
    or user_b = (select auth.uid())
  );

create policy conversation_members_select on public.conversation_members
  for select using (user_id = (select auth.uid()));

create policy conversations_select on public.conversations
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = conversations.id
        and cm.user_id = (select auth.uid())
    )
  );

create policy messages_select on public.messages
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id
        and cm.user_id = (select auth.uid())
    )
  );

create policy conversation_clips_select on public.conversation_clips
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = conversation_clips.conversation_id
        and cm.user_id = (select auth.uid())
    )
  );

create policy notifications_select on public.notifications
  for select using (user_id = (select auth.uid()));

revoke all on function public.enforce_conversation_member_limit() from public, anon, authenticated;
revoke all on function public.touch_conversation_on_message() from public, anon, authenticated;
revoke all on function public.get_clip_for_playback(text) from public, anon, authenticated;
grant execute on function public.get_clip_for_playback(text) to service_role;

revoke all on table public.friendships from anon, authenticated;
revoke all on table public.conversations from anon, authenticated;
revoke all on table public.conversation_members from anon, authenticated;
revoke all on table public.messages from anon, authenticated;
revoke all on table public.conversation_clips from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;

grant select on table public.friendships to authenticated;
grant select on table public.conversations to authenticated;
grant select on table public.conversation_members to authenticated;
grant select on table public.messages to authenticated;
grant select on table public.conversation_clips to authenticated;
grant select on table public.notifications to authenticated;

grant select, insert, update, delete on table public.friendships to service_role;
grant select, insert, update, delete on table public.conversations to service_role;
grant select, insert, update, delete on table public.conversation_members to service_role;
grant select, insert, update, delete on table public.messages to service_role;
grant select, insert, update, delete on table public.conversation_clips to service_role;
grant select, insert, update, delete on table public.notifications to service_role;

alter table public.messages replica identity full;
alter table public.notifications replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
