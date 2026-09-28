alter table public.staff_task_comments
  add column if not exists deleted_at timestamptz;

create index if not exists staff_task_comments_active_idx
  on public.staff_task_comments (task_id, created_at)
  where deleted_at is null;

alter table public.staff_task_attachments
  add column if not exists status text not null default 'ready';

alter table public.staff_task_attachments
  drop constraint if exists staff_task_attachments_status_check;

alter table public.staff_task_attachments
  add constraint staff_task_attachments_status_check
  check (status in ('pending', 'ready', 'failed'));

alter table public.staff_task_attachments
  add column if not exists width integer;

alter table public.staff_task_attachments
  add column if not exists height integer;

create index if not exists staff_task_attachments_task_idx
  on public.staff_task_attachments (task_id, created_at);
