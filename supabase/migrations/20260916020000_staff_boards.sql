-- Staff work boards, tasks, comments, attachments, activity, and staff notifications.

create table public.staff_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_boards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.staff_workspaces (id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  visibility text not null default 'staff' check (visibility in ('staff', 'role', 'private')),
  archived_at timestamptz,
  created_by uuid references public.staff_members (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index staff_boards_workspace_idx on public.staff_boards (workspace_id) where archived_at is null;

create table public.staff_board_role_grants (
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  role_id uuid not null references public.staff_roles (id) on delete cascade,
  primary key (board_id, role_id)
);

create table public.staff_board_members (
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  staff_id uuid not null references public.staff_members (id) on delete cascade,
  board_role text not null check (board_role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (board_id, staff_id)
);

create index staff_board_members_staff_idx on public.staff_board_members (staff_id);

create table public.staff_board_columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  name text not null,
  rank text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_board_columns_rank_idx
  on public.staff_board_columns (board_id, rank)
  where archived_at is null;

create table public.staff_labels (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  name text not null,
  color text not null default '#5b6b7c',
  created_at timestamptz not null default now()
);

create table public.staff_tasks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.staff_boards (id) on delete cascade,
  column_id uuid not null references public.staff_board_columns (id) on delete restrict,
  title text not null,
  description text,
  rank text not null,
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  created_by uuid references public.staff_members (id) on delete set null,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_tasks_column_rank_idx
  on public.staff_tasks (board_id, column_id, rank)
  where archived_at is null;
create index staff_tasks_due_idx on public.staff_tasks (due_at)
  where archived_at is null and completed_at is null and due_at is not null;
create index staff_tasks_created_by_idx on public.staff_tasks (created_by);

create table public.staff_task_assignees (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  staff_id uuid not null references public.staff_members (id) on delete cascade,
  primary key (task_id, staff_id)
);

create index staff_task_assignees_staff_idx on public.staff_task_assignees (staff_id);

create table public.staff_task_labels (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  label_id uuid not null references public.staff_labels (id) on delete cascade,
  primary key (task_id, label_id)
);

create table public.staff_task_checklists (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  title text not null,
  rank text not null,
  created_at timestamptz not null default now()
);

create table public.staff_task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.staff_task_checklists (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  rank text not null,
  created_at timestamptz not null default now()
);

create table public.staff_task_subtasks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  title text not null,
  assignee_staff_id uuid references public.staff_members (id) on delete set null,
  done boolean not null default false,
  rank text not null,
  created_at timestamptz not null default now()
);

create table public.staff_task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  parent_id uuid references public.staff_task_comments (id) on delete cascade,
  author_staff_id uuid references public.staff_members (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_task_comments_task_idx on public.staff_task_comments (task_id, created_at);

create table public.staff_task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime text,
  bytes integer,
  created_by uuid references public.staff_members (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.staff_task_relations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  kind text not null check (kind in ('clip', 'user', 'screenshot', 'folder', 'creator_application', 'error_fingerprint', 'url')),
  target_id text not null,
  label text,
  created_at timestamptz not null default now()
);

create index staff_task_relations_task_idx on public.staff_task_relations (task_id);

create table public.staff_task_watchers (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  staff_id uuid not null references public.staff_members (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, staff_id)
);

create table public.staff_task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  actor_staff_id uuid references public.staff_members (id) on delete set null,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index staff_task_activity_task_idx on public.staff_task_activity (task_id, created_at desc);

alter table public.notifications add column if not exists staff_task_id uuid references public.staff_tasks (id) on delete set null;

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
    'folder_invite_accepted',
    'folder_role_changed',
    'folder_ownership_transferred',
    'staff_task_assigned',
    'staff_task_mentioned',
    'staff_task_comment',
    'staff_task_due_soon'
  ));

create trigger staff_workspaces_updated_at
  before update on public.staff_workspaces
  for each row execute function public.set_updated_at();
create trigger staff_boards_updated_at
  before update on public.staff_boards
  for each row execute function public.set_updated_at();
create trigger staff_board_columns_updated_at
  before update on public.staff_board_columns
  for each row execute function public.set_updated_at();
create trigger staff_tasks_updated_at
  before update on public.staff_tasks
  for each row execute function public.set_updated_at();
create trigger staff_task_comments_updated_at
  before update on public.staff_task_comments
  for each row execute function public.set_updated_at();

insert into public.staff_workspaces (id, name, slug)
values ('00000000-0000-4000-8000-000000000010', 'Replayr', 'replayr')
on conflict (slug) do nothing;

insert into public.staff_boards (id, workspace_id, name, slug, description, visibility)
values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010', 'Development', 'development', 'Product and engineering work.', 'staff'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000010', 'Marketing', 'marketing', 'Campaigns and publishing.', 'staff'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000010', 'Bugs', 'bugs', 'Defects from capture to release.', 'staff')
on conflict do nothing;

insert into public.staff_board_columns (board_id, name, rank)
select b.id, c.name, c.rank
from public.staff_boards b
join (
  values
    ('development', 'Backlog', 'a0'),
    ('development', 'Planned', 'a1'),
    ('development', 'In Progress', 'a2'),
    ('development', 'Review', 'a3'),
    ('development', 'Testing', 'a4'),
    ('development', 'Ready for Release', 'a5'),
    ('development', 'Done', 'a6'),
    ('marketing', 'Ideas', 'a0'),
    ('marketing', 'Planned', 'a1'),
    ('marketing', 'Creating', 'a2'),
    ('marketing', 'Needs Approval', 'a3'),
    ('marketing', 'Scheduled', 'a4'),
    ('marketing', 'Published', 'a5'),
    ('bugs', 'Reported', 'a0'),
    ('bugs', 'Confirmed', 'a1'),
    ('bugs', 'In Progress', 'a2'),
    ('bugs', 'Testing', 'a3'),
    ('bugs', 'Fixed', 'a4'),
    ('bugs', 'Released', 'a5')
) as c(slug, name, rank) on c.slug = b.slug
where not exists (select 1 from public.staff_board_columns x where x.board_id = b.id);

insert into public.staff_labels (board_id, name, color)
select b.id, l.name, l.color
from public.staff_boards b
join (
  values
    ('Bug', '#c45c5c'),
    ('Feature', '#5b8ec9'),
    ('UI', '#8a7cc8'),
    ('Desktop', '#5aa38a'),
    ('Mobile', '#c9a27a'),
    ('Web', '#7fd0ef'),
    ('Security', '#d4a017')
) as l(name, color) on true
where not exists (select 1 from public.staff_labels x where x.board_id = b.id);

do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_workspaces',
    'staff_boards',
    'staff_board_role_grants',
    'staff_board_members',
    'staff_board_columns',
    'staff_labels',
    'staff_tasks',
    'staff_task_assignees',
    'staff_task_labels',
    'staff_task_checklists',
    'staff_task_checklist_items',
    'staff_task_subtasks',
    'staff_task_comments',
    'staff_task_attachments',
    'staff_task_relations',
    'staff_task_watchers',
    'staff_task_activity'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I_no_client on public.%I', t, t);
    execute format(
      'create policy %I_no_client on public.%I for all to anon, authenticated using (false) with check (false)',
      t, t
    );
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end
$$;
