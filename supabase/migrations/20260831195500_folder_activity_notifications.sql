-- Phase 5: notify members of role and ownership changes.
-- Activity reads stay owner/member only. Public visitors still cannot see drafts.

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
    'folder_ownership_transferred'
  ));
