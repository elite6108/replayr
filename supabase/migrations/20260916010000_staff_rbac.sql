-- Staff RBAC: membership, roles, permissions, invites, audit diffs.
-- Privileged tables are service-role only. Worker is the authorization boundary.

create table public.staff_permissions (
  key text primary key,
  category text not null,
  label text not null,
  description text,
  sort integer not null default 0
);

create table public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  color text,
  is_system boolean not null default false,
  is_super_admin boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_roles_super_admin_system_chk check (not is_super_admin or is_system)
);

create unique index staff_roles_one_super_admin on public.staff_roles (is_super_admin) where is_super_admin;

create table public.staff_role_permissions (
  role_id uuid not null references public.staff_roles (id) on delete cascade,
  permission_key text not null references public.staff_permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  display_name text not null,
  job_title text,
  department text,
  status text not null default 'active' check (status in ('active', 'suspended', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  last_active_at timestamptz
);

create index staff_members_status_idx on public.staff_members (status);
create index staff_members_department_idx on public.staff_members (department);

create table public.staff_role_assignments (
  staff_id uuid not null references public.staff_members (id) on delete cascade,
  role_id uuid not null references public.staff_roles (id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  primary key (staff_id, role_id)
);

create index staff_role_assignments_role_idx on public.staff_role_assignments (role_id);

create table public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null,
  display_name text,
  job_title text,
  department text,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  created_at timestamptz not null default now()
);

create unique index staff_invites_pending_email
  on public.staff_invites (email_normalized)
  where status = 'pending';

create table public.staff_invite_roles (
  invite_id uuid not null references public.staff_invites (id) on delete cascade,
  role_id uuid not null references public.staff_roles (id) on delete cascade,
  primary key (invite_id, role_id)
);

insert into public.staff_permissions (key, category, label, description, sort) values
  ('staff.access', 'access', 'Staff access', 'Enter the staff area and staff APIs.', 10),
  ('admin.access', 'access', 'Admin access', 'Enter the operator console.', 20),
  ('staff.members.view', 'staff', 'View staff', 'List staff members and profiles.', 110),
  ('staff.members.invite', 'staff', 'Invite staff', 'Send staff invitations.', 120),
  ('staff.members.edit', 'staff', 'Edit staff', 'Edit job title, department, and display name.', 130),
  ('staff.members.suspend', 'staff', 'Suspend staff', 'Suspend staff access.', 140),
  ('staff.members.remove', 'staff', 'Deactivate staff', 'Deactivate a staff membership.', 150),
  ('staff.roles.view', 'staff', 'View roles', 'List roles and permission catalogs.', 160),
  ('staff.roles.create', 'staff', 'Create roles', 'Create custom roles.', 170),
  ('staff.roles.edit', 'staff', 'Edit roles', 'Edit custom role permissions.', 180),
  ('staff.roles.delete', 'staff', 'Delete roles', 'Archive or delete custom roles.', 190),
  ('staff.roles.assign', 'staff', 'Assign roles', 'Assign roles to staff members.', 200),
  ('staff.roles.manage_all', 'staff', 'Manage all roles', 'Grant any permission, including Super Admin.', 210),
  ('users.view', 'users', 'View users', 'Search Replayr accounts.', 310),
  ('users.billing.edit', 'users', 'Edit billing', 'Change plans and complimentary subscriptions.', 320),
  ('users.quota.edit', 'users', 'Edit storage quota', 'Override per-account storage limits.', 330),
  ('clips.view', 'content', 'View clips', 'Search cloud clips in the operator console.', 410),
  ('clips.delete', 'content', 'Delete clips', 'Soft-delete clips and purge objects.', 420),
  ('screenshots.delete', 'content', 'Delete screenshots', 'Remove abusive screenshots.', 430),
  ('creators.view', 'creators', 'View creator applications', 'List creator applications.', 510),
  ('creators.review', 'creators', 'Review creators', 'Approve or reject creator applications.', 520),
  ('announcements.view', 'comms', 'View announcements', 'List announcement campaigns.', 610),
  ('announcements.manage', 'comms', 'Manage announcements', 'Create, edit, and delete announcements.', 620),
  ('system.settings.view', 'config', 'View system settings', 'Read watermark and ads flags.', 710),
  ('system.settings.edit', 'config', 'Edit system settings', 'Toggle global watermark and ads.', 720),
  ('system.plans.edit', 'config', 'Edit plans', 'Change plan storage, duration, and feature flags.', 730),
  ('errors.view', 'ops', 'View errors', 'Read grouped client and worker errors.', 810),
  ('errors.resolve', 'ops', 'Resolve errors', 'Mark error groups resolved.', 820),
  ('analytics.view', 'analytics', 'View analytics', 'Open analytics dashboards.', 910),
  ('analytics.config', 'analytics', 'Edit analytics config', 'Edit cost assumptions.', 920),
  ('analytics.reports', 'analytics', 'Analytics reports', 'Generate and export analytics reports.', 930),
  ('analytics.backfill', 'analytics', 'Analytics backfill', 'Rebuild analytics rollups.', 940),
  ('audit.view', 'security', 'View audit log', 'Read the append-only admin audit log.', 1010),
  ('board.view', 'board', 'View boards', 'Open staff work boards.', 1110),
  ('board.create', 'board', 'Create boards', 'Create work boards.', 1120),
  ('board.edit', 'board', 'Edit boards', 'Rename boards and manage columns.', 1130),
  ('board.delete', 'board', 'Archive boards', 'Archive work boards.', 1140),
  ('board.members.manage', 'board', 'Manage board members', 'Change board membership and visibility.', 1150),
  ('board.columns.create', 'board', 'Create columns', 'Add board columns.', 1160),
  ('board.columns.edit', 'board', 'Edit columns', 'Rename board columns.', 1170),
  ('board.columns.delete', 'board', 'Delete columns', 'Archive board columns.', 1180),
  ('board.cards.create', 'board', 'Create tasks', 'Create cards.', 1190),
  ('board.cards.edit', 'board', 'Edit tasks', 'Edit card fields.', 1200),
  ('board.cards.delete', 'board', 'Archive tasks', 'Archive cards.', 1210),
  ('board.cards.move', 'board', 'Move tasks', 'Drag cards between columns.', 1220),
  ('board.cards.assign', 'board', 'Assign tasks', 'Change card assignees.', 1230),
  ('board.comments.create', 'board', 'Comment on tasks', 'Add internal task comments.', 1240),
  ('board.comments.delete', 'board', 'Delete comments', 'Remove task comments.', 1250),
  ('board.labels.manage', 'board', 'Manage labels', 'Create and edit board labels.', 1260),
  ('board.checklists.manage', 'board', 'Manage checklists', 'Edit checklists and subtasks.', 1270),
  ('board.attachments.upload', 'board', 'Upload attachments', 'Attach files to tasks.', 1280),
  ('board.attachments.delete', 'board', 'Delete attachments', 'Remove task attachments.', 1290);

insert into public.staff_roles (id, slug, name, description, color, is_system, is_super_admin) values
  ('00000000-0000-4000-8000-000000000001', 'super_admin', 'Super Admin', 'All permissions. Cannot be stripped if last remaining.', '#7fd0ef', true, true),
  ('00000000-0000-4000-8000-000000000002', 'admin', 'Admin', 'Operator console plus staff management.', '#8ee0a8', true, false),
  ('00000000-0000-4000-8000-000000000003', 'staff', 'Staff', 'Work boards without operator console access.', '#c9a27a', true, false);

insert into public.staff_role_permissions (role_id, permission_key)
select '00000000-0000-4000-8000-000000000002', key
from public.staff_permissions
where key <> 'staff.roles.manage_all';

insert into public.staff_role_permissions (role_id, permission_key) values
  ('00000000-0000-4000-8000-000000000003', 'staff.access'),
  ('00000000-0000-4000-8000-000000000003', 'board.view'),
  ('00000000-0000-4000-8000-000000000003', 'board.cards.create'),
  ('00000000-0000-4000-8000-000000000003', 'board.cards.edit'),
  ('00000000-0000-4000-8000-000000000003', 'board.cards.move'),
  ('00000000-0000-4000-8000-000000000003', 'board.cards.assign'),
  ('00000000-0000-4000-8000-000000000003', 'board.comments.create'),
  ('00000000-0000-4000-8000-000000000003', 'board.attachments.upload');

create or replace function public.staff_has_permission(p_user_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_members m
    join public.staff_role_assignments a on a.staff_id = m.id
    join public.staff_roles r on r.id = a.role_id
    where m.user_id = p_user_id
      and m.status = 'active'
      and r.archived_at is null
      and (
        r.is_super_admin
        or exists (
          select 1
          from public.staff_role_permissions p
          where p.role_id = r.id
            and p.permission_key = p_key
        )
      )
  );
$$;

revoke all on function public.staff_has_permission(uuid, text) from public, anon, authenticated;
grant execute on function public.staff_has_permission(uuid, text) to service_role;

create or replace function public.staff_guard_last_super_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
  was_super boolean := false;
begin
  if tg_table_name = 'staff_role_assignments' then
    select r.is_super_admin into was_super from public.staff_roles r where r.id = old.role_id;
    if not coalesce(was_super, false) then
      return old;
    end if;
    select count(*) into remaining
    from public.staff_role_assignments a
    join public.staff_roles r on r.id = a.role_id and r.is_super_admin
    join public.staff_members m on m.id = a.staff_id and m.status = 'active'
    where a.staff_id <> old.staff_id;
    if remaining < 1 then
      raise exception 'Cannot remove the last Super Admin.';
    end if;
    return old;
  end if;

  if tg_table_name = 'staff_members' then
    if tg_op = 'DELETE' then
      select exists (
        select 1
        from public.staff_role_assignments a
        join public.staff_roles r on r.id = a.role_id and r.is_super_admin
        where a.staff_id = old.id
      ) into was_super;
      if was_super and old.status = 'active' then
        select count(*) into remaining
        from public.staff_members m
        join public.staff_role_assignments a on a.staff_id = m.id
        join public.staff_roles r on r.id = a.role_id and r.is_super_admin
        where m.status = 'active' and m.id <> old.id;
        if remaining < 1 then
          raise exception 'Cannot remove the last Super Admin.';
        end if;
      end if;
      return old;
    end if;
    if old.status = 'active' and new.status is distinct from 'active' then
      select exists (
        select 1
        from public.staff_role_assignments a
        join public.staff_roles r on r.id = a.role_id and r.is_super_admin
        where a.staff_id = old.id
      ) into was_super;
      if was_super then
        select count(*) into remaining
        from public.staff_members m
        join public.staff_role_assignments a on a.staff_id = m.id
        join public.staff_roles r on r.id = a.role_id and r.is_super_admin
        where m.status = 'active' and m.id <> old.id;
        if remaining < 1 then
          raise exception 'Cannot suspend or deactivate the last Super Admin.';
        end if;
      end if;
    end if;
    return new;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger staff_role_assignments_guard_super
  before delete on public.staff_role_assignments
  for each row execute function public.staff_guard_last_super_admin();

create trigger staff_members_guard_super
  before update or delete on public.staff_members
  for each row execute function public.staff_guard_last_super_admin();

create trigger staff_roles_updated_at
  before update on public.staff_roles
  for each row execute function public.set_updated_at();

create trigger staff_members_updated_at
  before update on public.staff_members
  for each row execute function public.set_updated_at();

insert into public.staff_members (user_id, display_name, status)
select
  u.id,
  coalesce(nullif(trim(p.display_name), ''), nullif(trim(p.username), ''), split_part(u.email, '@', 1), 'Operator'),
  'active'
from auth.users u
left join public.profiles p on p.id = u.id
where coalesce(u.raw_app_meta_data->>'role', '') = 'admin'
on conflict (user_id) do nothing;

insert into public.staff_role_assignments (staff_id, role_id)
select m.id, '00000000-0000-4000-8000-000000000001'
from public.staff_members m
join auth.users u on u.id = m.user_id
where coalesce(u.raw_app_meta_data->>'role', '') = 'admin'
on conflict do nothing;

alter table public.audit_log add column if not exists before jsonb;
alter table public.audit_log add column if not exists after jsonb;

do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_permissions',
    'staff_roles',
    'staff_role_permissions',
    'staff_members',
    'staff_role_assignments',
    'staff_invites',
    'staff_invite_roles'
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
