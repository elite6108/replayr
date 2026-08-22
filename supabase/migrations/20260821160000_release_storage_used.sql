-- Return cloud quota when an owner deletes a ready clip.

create or replace function public.release_storage_used(p_bytes bigint)
returns table(storage_used_bytes bigint, storage_limit_bytes bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  current public.user_storage%rowtype;
begin
  if p_bytes is null or p_bytes < 0 or p_bytes > 10737418240 then
    raise exception 'invalid size' using errcode = '22023';
  end if;

  select *
    into current
    from public.user_storage
   where user_id = auth.uid()
   for update;

  if not found then
    raise exception 'No storage plan is attached to this account.' using errcode = 'P0002';
  end if;

  return query
    update public.user_storage
       set storage_used_bytes = greatest(0, public.user_storage.storage_used_bytes - p_bytes)
     where user_id = auth.uid()
     returning public.user_storage.storage_used_bytes, public.user_storage.storage_limit_bytes;
end;
$$;

revoke all on function public.release_storage_used(bigint) from public, anon;
grant execute on function public.release_storage_used(bigint) to authenticated;
