delete from public.staff_task_assignees a
using public.staff_tasks t
where a.task_id = t.id
  and not exists (
    select 1
    from public.staff_board_members m
    where m.board_id = t.board_id
      and m.staff_id = a.staff_id
  );

delete from public.staff_task_watchers w
using public.staff_tasks t
where w.task_id = t.id
  and not exists (
    select 1
    from public.staff_board_members m
    where m.board_id = t.board_id
      and m.staff_id = w.staff_id
  );

update public.staff_task_subtasks s
set assignee_staff_id = null
from public.staff_tasks t
where s.task_id = t.id
  and s.assignee_staff_id is not null
  and not exists (
    select 1
    from public.staff_board_members m
    where m.board_id = t.board_id
      and m.staff_id = s.assignee_staff_id
  );
