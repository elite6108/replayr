-- Phase 3.5: atomic folder ownership transfer.
-- folders.owner_id stays the only owner source of truth.
-- The current owner becomes Manager. The target member becomes owner
-- and their folder_members row is removed. Never two owners or zero owners.
-- Public link columns and folder_clips are not touched.
-- Blocks do not prevent transferring to an existing collaborator.

create or replace function public.transfer_folder_ownership(
  p_folder_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_owner uuid;
  target_role text;
begin
  if p_folder_id is null or p_from_user_id is null or p_to_user_id is null then
    raise exception 'FOLDER_TRANSFER_NOT_FOUND';
  end if;

  if p_from_user_id = p_to_user_id then
    raise exception 'FOLDER_TRANSFER_SELF';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_to_user_id) then
    raise exception 'FOLDER_TRANSFER_INVALID_USER';
  end if;

  select f.owner_id
    into current_owner
    from public.folders f
   where f.id = p_folder_id
   for update;

  if current_owner is null then
    raise exception 'FOLDER_TRANSFER_NOT_FOUND';
  end if;

  if current_owner <> p_from_user_id then
    raise exception 'FOLDER_TRANSFER_FORBIDDEN';
  end if;

  select m.role
    into target_role
    from public.folder_members m
   where m.folder_id = p_folder_id
     and m.user_id = p_to_user_id
   for update;

  if target_role is null then
    raise exception 'FOLDER_TRANSFER_NOT_MEMBER';
  end if;

  delete from public.folder_members
   where folder_id = p_folder_id
     and user_id = p_to_user_id;

  update public.folders
     set owner_id = p_to_user_id
   where id = p_folder_id
     and owner_id = p_from_user_id;

  if not found then
    raise exception 'FOLDER_TRANSFER_FORBIDDEN';
  end if;

  insert into public.folder_members (folder_id, user_id, role, invited_by)
  values (p_folder_id, p_from_user_id, 'manager', p_to_user_id);

  return p_to_user_id;
end;
$$;

revoke all on function public.transfer_folder_ownership(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_folder_ownership(uuid, uuid, uuid) to service_role;
