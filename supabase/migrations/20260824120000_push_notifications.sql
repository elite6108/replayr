-- Push tokens, per-type prefs, and clip like/comment inbox rows.

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'friend_request',
    'friend_accept',
    'message',
    'group_invite',
    'clip_like',
    'clip_comment'
  ));

alter table public.notifications
  add column if not exists clip_id uuid references public.clips (id) on delete set null;

create index if not exists notifications_clip_idx on public.notifications (clip_id)
  where clip_id is not null;

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

create table if not exists public.notification_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  friend_requests boolean not null default true,
  likes boolean not null default true,
  comments boolean not null default true,
  messages boolean not null default true,
  updated_at timestamptz not null default now()
);

create trigger push_tokens_updated_at
before update on public.push_tokens
for each row execute function public.set_updated_at();

create trigger notification_prefs_updated_at
before update on public.notification_prefs
for each row execute function public.set_updated_at();

alter table public.push_tokens enable row level security;
alter table public.notification_prefs enable row level security;

revoke all on table public.push_tokens from anon, authenticated;
revoke all on table public.notification_prefs from anon, authenticated;

grant select, insert, update, delete on table public.push_tokens to service_role;
grant select, insert, update, delete on table public.notification_prefs to service_role;
