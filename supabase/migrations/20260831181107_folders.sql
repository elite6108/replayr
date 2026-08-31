-- Replayr folders: cloud/social containers. Clip ownership stays on clips.user_id.
-- Writes go through the Worker (service role). Clients have SELECT only.

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text null check (description is null or char_length(description) <= 500),
  visibility text not null default 'private' check (visibility in ('private', 'public_link')),
  allow_downloads boolean not null default true,
  public_slug text unique null,
  public_token_version integer not null default 1,
  cover_clip_id uuid null references public.clips (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index folders_owner_created_idx on public.folders (owner_id, created_at desc);
create index folders_public_slug_idx on public.folders (public_slug) where public_slug is not null;

create table public.folder_clips (
  folder_id uuid not null references public.folders (id) on delete cascade,
  clip_id uuid not null references public.clips (id) on delete cascade,
  added_by uuid not null references public.profiles (id) on delete restrict,
  position integer null,
  created_at timestamptz not null default now(),
  primary key (folder_id, clip_id)
);

create index folder_clips_clip_id_idx on public.folder_clips (clip_id);
create index folder_clips_folder_created_idx on public.folder_clips (folder_id, created_at desc);

create table public.folder_members (
  folder_id uuid not null references public.folders (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('manager', 'editor', 'viewer')),
  invited_by uuid null references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (folder_id, user_id)
);

create index folder_members_user_id_idx on public.folder_members (user_id);

create table public.folder_invites (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders (id) on delete cascade,
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  invitee_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('manager', 'editor', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  expires_at timestamptz null,
  check (inviter_id <> invitee_id)
);

create unique index folder_invites_pending_unique
  on public.folder_invites (folder_id, invitee_id)
  where status = 'pending';
create index folder_invites_invitee_idx on public.folder_invites (invitee_id, created_at desc);

create or replace function public.folder_members_reject_owner()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.folders f
    where f.id = new.folder_id
      and f.owner_id = new.user_id
  ) then
    raise exception 'Folder owner cannot be stored as a member';
  end if;
  return new;
end;
$$;

create trigger folders_updated_at
  before update on public.folders
  for each row
  execute function public.set_updated_at();

create trigger folder_members_reject_owner
  before insert or update on public.folder_members
  for each row
  execute function public.folder_members_reject_owner();

alter table public.folders enable row level security;
alter table public.folders force row level security;
alter table public.folder_clips enable row level security;
alter table public.folder_clips force row level security;
alter table public.folder_members enable row level security;
alter table public.folder_members force row level security;
alter table public.folder_invites enable row level security;
alter table public.folder_invites force row level security;

create policy folders_select on public.folders
  for select
  using (owner_id = (select auth.uid()));

create policy folder_clips_select on public.folder_clips
  for select
  using (
    exists (
      select 1
      from public.folders f
      where f.id = folder_id
        and f.owner_id = (select auth.uid())
    )
  );

create policy folder_members_select on public.folder_members
  for select
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.folders f
      where f.id = folder_id
        and f.owner_id = (select auth.uid())
    )
  );

create policy folder_invites_select on public.folder_invites
  for select
  using (
    invitee_id = (select auth.uid())
    or inviter_id = (select auth.uid())
    or exists (
      select 1
      from public.folders f
      where f.id = folder_id
        and f.owner_id = (select auth.uid())
    )
  );

revoke all on table public.folders from anon, authenticated;
revoke all on table public.folder_clips from anon, authenticated;
revoke all on table public.folder_members from anon, authenticated;
revoke all on table public.folder_invites from anon, authenticated;

grant select on table public.folders to authenticated;
grant select on table public.folder_clips to authenticated;
grant select on table public.folder_members to authenticated;
grant select on table public.folder_invites to authenticated;

grant select, insert, update, delete on table public.folders to service_role;
grant select, insert, update, delete on table public.folder_clips to service_role;
grant select, insert, update, delete on table public.folder_members to service_role;
grant select, insert, update, delete on table public.folder_invites to service_role;
