-- One-row slug lookup for the public player. Unlisted clips are not
-- listable via PostgREST; this RPC returns a single ready clip if the
-- caller may watch it (public/unlisted, or private + owner).

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
        or (c.visibility = 'private' and c.user_id = auth.uid())
      )
    limit 1;
end;
$$;

revoke all on function public.get_clip_for_playback(text) from public;
grant execute on function public.get_clip_for_playback(text) to anon, authenticated;
