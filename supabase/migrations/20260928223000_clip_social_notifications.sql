alter table public.notifications
  add column if not exists clip_id uuid references public.clips (id) on delete set null;

create index if not exists notifications_clip_id_idx on public.notifications (clip_id);

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
    'staff_task_due_soon',
    'clip_like',
    'clip_comment'
  ));
