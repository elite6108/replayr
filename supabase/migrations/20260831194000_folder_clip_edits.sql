-- Phase 4: non-destructive folder clip edits + lightweight activity.
-- Edits belong to folder membership (folder_id, clip_id) and cascade when
-- the source is removed from the folder or the folder is deleted.
-- Removing a source does not delete the original clip or separately added
-- rendered copies. Public visitors cannot read edit drafts.

create table public.folder_clip_edits (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null,
  clip_id uuid not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  updated_by uuid not null references public.profiles (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  edit_data jsonb not null default '{"version":1}'::jsonb
    check (jsonb_typeof(edit_data) = 'object'),
  revision integer not null default 1 check (revision >= 1),
  rendered_clip_id uuid null references public.clips (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (folder_id, clip_id)
    references public.folder_clips (folder_id, clip_id)
    on delete cascade
);

create index folder_clip_edits_folder_clip_idx
  on public.folder_clip_edits (folder_id, clip_id, updated_at desc);
create index folder_clip_edits_rendered_idx
  on public.folder_clip_edits (rendered_clip_id)
  where rendered_clip_id is not null;

create trigger folder_clip_edits_updated_at
  before update on public.folder_clip_edits
  for each row
  execute function public.set_updated_at();

create table public.folder_activity (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders (id) on delete cascade,
  actor_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in (
    'edit_created',
    'edit_rendered',
    'edit_deleted',
    'clip_added',
    'clip_removed',
    'member_role_changed',
    'ownership_transferred'
  )),
  entity_id uuid null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index folder_activity_folder_created_idx
  on public.folder_activity (folder_id, created_at desc);

alter table public.folder_clip_edits enable row level security;
alter table public.folder_clip_edits force row level security;
alter table public.folder_activity enable row level security;
alter table public.folder_activity force row level security;

create policy folder_clip_edits_select on public.folder_clip_edits
  for select
  using (
    exists (
      select 1
      from public.folders f
      where f.id = folder_clip_edits.folder_id
        and f.owner_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.folder_members m
      where m.folder_id = folder_clip_edits.folder_id
        and m.user_id = (select auth.uid())
    )
  );

create policy folder_activity_select on public.folder_activity
  for select
  using (
    exists (
      select 1
      from public.folders f
      where f.id = folder_activity.folder_id
        and f.owner_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.folder_members m
      where m.folder_id = folder_activity.folder_id
        and m.user_id = (select auth.uid())
    )
  );

revoke all on table public.folder_clip_edits from anon, authenticated;
revoke all on table public.folder_activity from anon, authenticated;
grant select on table public.folder_clip_edits to authenticated;
grant select on table public.folder_activity to authenticated;
grant select, insert, update, delete on table public.folder_clip_edits to service_role;
grant select, insert, update, delete on table public.folder_activity to service_role;
