-- Lets a new reel picker replace cached cuts without reusing the old ones.

alter table public.ai_moment_cache
  add column if not exists picker text;

update public.ai_moment_cache
   set picker = 'v1'
 where picker is null;

alter table public.ai_moment_cache
  alter column picker set default 'v1';

alter table public.ai_moment_cache
  alter column picker set not null;

alter table public.ai_moment_cache
  drop constraint if exists ai_moment_cache_picker_check;

alter table public.ai_moment_cache
  add constraint ai_moment_cache_picker_check
  check (picker ~ '^[a-z0-9-]{1,32}$');

alter table public.ai_moment_cache
  drop constraint if exists ai_moment_cache_pkey;

alter table public.ai_moment_cache
  add primary key (transcript_id, format, picker);
