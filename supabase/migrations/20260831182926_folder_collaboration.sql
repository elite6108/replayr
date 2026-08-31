-- Phase 2: private folder collaboration.
-- Writes stay service-role only. Clients get SELECT for folders they own
-- or actively belong to. A pending invite does not expose folder_clips.
--
-- Blocks vs membership: new invitations fail when either user has blocked
-- the other. An existing folder_members row is NOT removed if a block is
-- created later. Collaboration and social blocking stay separate.

alter table public.notifications
  add column if not exists folder_id uuid references public.folders (id) on delete set null;

create index if not exists notifications_folder_id_idx
  on public.notifications (folder_id)
  where folder_id is not null;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in (
    'friend_request',
    'friend_accept',
    'follow_request',
    'follow_accept',
    'message',
    'group_invite',
    'folder_invite',
    'folder_invite_accepted'
  ));

drop policy if exists folders_select on public.folders;
drop policy if exists folder_clips_select on public.folder_clips;
drop policy if exists folder_members_select on public.folder_members;
drop policy if exists folder_invites_select on public.folder_invites;

-- Own identity clauses avoid RLS recursion between folders and folder_members.
create policy folders_select on public.folders
  for select
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.folder_members m
      where m.folder_id = folders.id
        and m.user_id = (select auth.uid())
    )
  );

-- Pending invitees are not members, so they cannot read folder clips.
create policy folder_clips_select on public.folder_clips
  for select
  using (
    exists (
      select 1
      from public.folders f
      where f.id = folder_clips.folder_id
        and f.owner_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.folder_members m
      where m.folder_id = folder_clips.folder_id
        and m.user_id = (select auth.uid())
    )
  );

create policy folder_members_select on public.folder_members
  for select
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.folders f
      where f.id = folder_members.folder_id
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
      where f.id = folder_invites.folder_id
        and f.owner_id = (select auth.uid())
    )
  );
