alter table public.staff_boards
  alter column visibility set default 'private';

insert into public.staff_board_members (board_id, staff_id, board_role)
select id, created_by, 'admin'
from public.staff_boards
where created_by is not null
on conflict (board_id, staff_id)
do update set board_role = 'admin';

update public.staff_boards
set visibility = 'private'
where visibility <> 'private';

update public.staff_permissions
set
  label = 'Delete boards',
  description = 'Permanently delete owned work boards and their contents.'
where key = 'board.delete';

create or replace function public.cleanup_removed_staff_board_member()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.staff_task_assignees a
  using public.staff_tasks t
  where a.task_id = t.id
    and t.board_id = old.board_id
    and a.staff_id = old.staff_id;

  delete from public.staff_task_watchers w
  using public.staff_tasks t
  where w.task_id = t.id
    and t.board_id = old.board_id
    and w.staff_id = old.staff_id;

  update public.staff_task_subtasks s
  set assignee_staff_id = null
  from public.staff_tasks t
  where s.task_id = t.id
    and t.board_id = old.board_id
    and s.assignee_staff_id = old.staff_id;

  return old;
end;
$$;

drop trigger if exists cleanup_removed_staff_board_member on public.staff_board_members;
create trigger cleanup_removed_staff_board_member
  after delete on public.staff_board_members
  for each row execute function public.cleanup_removed_staff_board_member();

revoke all on function public.cleanup_removed_staff_board_member() from public, anon, authenticated;
grant execute on function public.cleanup_removed_staff_board_member() to service_role;
