-- Cache auth.uid() once per statement (auth_rls_initplan).
-- Predicates stay the same; only the uid lookup is wrapped.

alter policy profiles_select on public.profiles
  using (is_private = false or id = (select auth.uid()));

alter policy profiles_update on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy user_storage_select on public.user_storage
  using (user_id = (select auth.uid()));

alter policy clips_owner_all on public.clips
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy upload_sessions_owner_all on public.upload_sessions
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy creator_applications_owner_select on public.creator_applications
  using (user_id = (select auth.uid()));

alter policy creator_applications_owner_insert on public.creator_applications
  with check (user_id = (select auth.uid()));

create or replace function public.get_clip_for_playback(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  duration_ms integer,
  width integer,
  height integer,
  visibility text,
  status text,
  storage_key text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{6,16}$' then
    return;
  end if;

  return query
    select
      c.id,
      c.slug,
      c.title,
      c.duration_ms,
      c.width,
      c.height,
      c.visibility,
      c.status,
      c.storage_key
    from public.clips c
    where c.slug = p_slug
      and c.status = 'ready'
      and c.storage_key is not null
      and (
        c.visibility in ('public', 'unlisted')
        or (c.visibility = 'private' and c.user_id = (select auth.uid()))
      )
    limit 1;
end;
$$;

revoke all on function public.get_clip_for_playback(text) from public, anon, authenticated;
