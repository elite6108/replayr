-- Public-clip likes and comments. Writes go through the Worker (service role).
-- Unlisted/private clips stay off feeds; clients cannot read these tables.

create table public.clip_likes (
  clip_id uuid not null references public.clips (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (clip_id, user_id)
);

create index clip_likes_user_idx on public.clip_likes (user_id, created_at desc);

create table public.clip_comments (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index clip_comments_clip_idx on public.clip_comments (clip_id, created_at asc);

create or replace function public.sync_clip_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.clips
      set like_count = like_count + 1
      where id = new.clip_id;
    return new;
  end if;
  update public.clips
    set like_count = greatest(like_count - 1, 0)
    where id = old.clip_id;
  return old;
end;
$$;

create or replace function public.sync_clip_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.clips
      set comment_count = comment_count + 1
      where id = new.clip_id;
    return new;
  end if;
  update public.clips
    set comment_count = greatest(comment_count - 1, 0)
    where id = old.clip_id;
  return old;
end;
$$;

create trigger clip_likes_count
after insert or delete on public.clip_likes
for each row execute function public.sync_clip_like_count();

create trigger clip_comments_count
after insert or delete on public.clip_comments
for each row execute function public.sync_clip_comment_count();

alter table public.clip_likes enable row level security;
alter table public.clip_comments enable row level security;

revoke all on function public.sync_clip_like_count() from public, anon, authenticated;
revoke all on function public.sync_clip_comment_count() from public, anon, authenticated;
revoke all on table public.clip_likes from anon, authenticated;
revoke all on table public.clip_comments from anon, authenticated;
