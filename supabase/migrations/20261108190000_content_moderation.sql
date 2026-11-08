-- User reports, staff-managed objectionable-text terms, and account suspension.
-- The token steps match worker/src/contentPolicy.ts. Change both together.
-- Terms and reports are service-role only. Clients never read the word list.

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.moderation_tokens(input text)
returns text[]
language plpgsql
immutable
as $$
declare
  folded text;
  mapped text := '';
  idx integer;
  ch text;
  parts text[];
  piece text;
  token text;
  tokens text[] := '{}';
  singles text := '';
begin
  if input is null or btrim(input) = '' then
    return '{}';
  end if;

  folded := lower(normalize(btrim(input), nfkc));
  folded := translate(
    folded,
    chr(8203) || chr(8204) || chr(8205) || chr(65279) || chr(8288),
    ''
  );

  for idx in 1..char_length(folded) loop
    ch := substr(folded, idx, 1);
    mapped := mapped || case ch
      when '0' then 'o'
      when '1' then 'i'
      when '3' then 'e'
      when '4' then 'a'
      when '5' then 's'
      when '7' then 't'
      when '@' then 'a'
      when '$' then 's'
      when '!' then 'i'
      else ch
    end;
  end loop;

  mapped := translate(mapped, $apos$'’‘′`$apos$, '');
  parts := regexp_split_to_array(mapped, '[^a-z]+');

  foreach piece in array parts loop
    if piece is null or piece = '' then
      continue;
    end if;
    token := regexp_replace(piece, $re$([a-z])\1{2,}$re$, $rep$\1$rep$, 'g');
    tokens := tokens || token;
    if char_length(token) = 1 then
      singles := singles || token;
    else
      if char_length(singles) >= 3 then
        tokens := tokens || regexp_replace(singles, $re$([a-z])\1{2,}$re$, $rep$\1$rep$, 'g');
      end if;
      singles := '';
    end if;
  end loop;

  if char_length(singles) >= 3 then
    tokens := tokens || regexp_replace(singles, $re$([a-z])\1{2,}$re$, $rep$\1$rep$, 'g');
  end if;

  return tokens;
end;
$$;

create or replace function private.canonical_term(input text)
returns text
language plpgsql
immutable
as $$
declare
  token text;
  kept text[] := '{}';
  key text;
begin
  foreach token in array private.moderation_tokens(input) loop
    if char_length(token) < 3 then
      continue;
    end if;
    if cardinality(kept) = 0 or kept[cardinality(kept)] is distinct from token then
      kept := kept || token;
    end if;
  end loop;
  if cardinality(kept) = 0 then
    return null;
  end if;
  key := array_to_string(kept, ' ');
  if char_length(replace(key, ' ', '')) < 3 or char_length(key) > 80 then
    return null;
  end if;
  return key;
end;
$$;

create table public.moderation_terms (
  id uuid primary key default gen_random_uuid(),
  term text not null,
  normalized text not null,
  category text not null check (category in ('profanity', 'slur', 'sexual', 'threat', 'other')),
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid references auth.users (id) on delete set null,
  constraint moderation_terms_term_len check (char_length(term) between 2 and 64),
  constraint moderation_terms_normalized_len check (char_length(normalized) between 3 and 80),
  constraint moderation_terms_note_len check (note is null or char_length(note) between 1 and 200)
);

create unique index moderation_terms_active_normalized
  on public.moderation_terms (normalized)
  where retired_at is null;

create index moderation_terms_category_idx on public.moderation_terms (category) where retired_at is null;

alter table public.moderation_terms enable row level security;
alter table public.moderation_terms force row level security;
revoke all on table public.moderation_terms from public, anon, authenticated;

create or replace function private.text_is_objectionable(input text)
returns boolean
language plpgsql
stable
security definer
set search_path = private, public, pg_catalog
as $$
declare
  tokens text[];
  term text;
  parts text[];
  start_at integer;
  offset_at integer;
  matched boolean;
begin
  if input is null or btrim(input) = '' then
    return false;
  end if;
  tokens := private.moderation_tokens(input);
  if cardinality(tokens) = 0 then
    return false;
  end if;

  for term in
    select normalized
    from public.moderation_terms
    where retired_at is null
  loop
    parts := string_to_array(term, ' ');
    if cardinality(parts) = 0 or cardinality(parts) > cardinality(tokens) then
      continue;
    end if;
    for start_at in 1..(cardinality(tokens) - cardinality(parts) + 1) loop
      matched := true;
      for offset_at in 1..cardinality(parts) loop
        if tokens[start_at + offset_at - 1] is distinct from parts[offset_at] then
          matched := false;
          exit;
        end if;
      end loop;
      if matched then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end;
$$;

create or replace function private.raise_objectionable()
returns void
language plpgsql
as $$
begin
  raise exception 'That text isn''t allowed on Replayr.' using errcode = '23514';
end;
$$;

create or replace function private.reject_text(value text, previous text, is_insert boolean)
returns void
language plpgsql
as $$
begin
  if not is_insert and value is not distinct from previous then
    return;
  end if;
  if private.text_is_objectionable(value) then
    perform private.raise_objectionable();
  end if;
end;
$$;

create or replace function private.check_profile_name(value text)
returns void
language plpgsql
as $$
begin
  if value is not null and char_length(value) > 80 then
    raise exception 'Display names must be 80 characters or fewer.' using errcode = '23514';
  end if;
  perform private.reject_text(value, null, true);
end;
$$;

create or replace function private.check_profile_bio(value text)
returns void
language plpgsql
as $$
begin
  if value is not null and char_length(value) > 280 then
    raise exception 'Bios must be 280 characters or fewer.' using errcode = '23514';
  end if;
  perform private.reject_text(value, null, true);
end;
$$;

create or replace function private.check_profile_text(display_name text, bio text)
returns void
language plpgsql
as $$
begin
  perform private.check_profile_name(display_name);
  perform private.check_profile_bio(bio);
end;
$$;

create or replace function private.check_clip_title(value text)
returns void
language plpgsql
as $$
begin
  if value is not null and char_length(btrim(value)) > 120 then
    raise exception 'Clip names must be 120 characters or fewer.' using errcode = '23514';
  end if;
  perform private.reject_text(value, null, true);
end;
$$;

create or replace function private.reject_objectionable_text()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare
  is_insert boolean := tg_op = 'INSERT';
begin
  if tg_table_name = 'profiles' then
    perform private.reject_text(new.username, case when is_insert then null else old.username end, is_insert);
    if is_insert then
      perform private.check_profile_text(new.display_name, new.bio);
    else
      if new.display_name is distinct from old.display_name then
        perform private.check_profile_name(new.display_name);
      end if;
      if new.bio is distinct from old.bio then
        perform private.check_profile_bio(new.bio);
      end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'clips' then
    if is_insert then
      perform private.check_clip_title(new.title);
    elsif new.title is distinct from old.title then
      perform private.check_clip_title(new.title);
    end if;
    return new;
  end if;

  if tg_table_name = 'folders' then
    perform private.reject_text(new.name, case when is_insert then null else old.name end, is_insert);
    perform private.reject_text(new.description, case when is_insert then null else old.description end, is_insert);
    return new;
  end if;

  if tg_table_name = 'clip_comments' or tg_table_name = 'posts' then
    perform private.reject_text(new.body, case when is_insert then null else old.body end, is_insert);
    return new;
  end if;

  if tg_table_name = 'messages' then
    perform private.reject_text(new.body, case when is_insert then null else old.body end, is_insert);
    return new;
  end if;

  if tg_table_name = 'conversations' then
    perform private.reject_text(new.title, case when is_insert then null else old.title end, is_insert);
    return new;
  end if;

  return new;
end;
$$;

create or replace function private.reject_if_suspended_actor()
returns trigger
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    return new;
  end if;
  if exists (
    select 1
    from public.profiles
    where id = actor
      and suspended_at is not null
  ) then
    raise exception 'This account is suspended.' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter function private.moderation_tokens(text) set search_path = private, public, pg_catalog;
alter function private.canonical_term(text) set search_path = private, public, pg_catalog;
alter function private.raise_objectionable() set search_path = private, public, pg_catalog;
alter function private.reject_text(text, text, boolean) set search_path = private, public, pg_catalog;
alter function private.check_profile_name(text) set search_path = private, public, pg_catalog;
alter function private.check_profile_bio(text) set search_path = private, public, pg_catalog;
alter function private.check_profile_text(text, text) set search_path = private, public, pg_catalog;
alter function private.check_clip_title(text) set search_path = private, public, pg_catalog;

revoke all on function private.moderation_tokens(text) from public, anon, authenticated;
revoke all on function private.canonical_term(text) from public, anon, authenticated;
revoke all on function private.text_is_objectionable(text) from public, anon, authenticated;
revoke all on function private.raise_objectionable() from public, anon, authenticated;
revoke all on function private.reject_text(text, text, boolean) from public, anon, authenticated;
revoke all on function private.check_profile_name(text) from public, anon, authenticated;
revoke all on function private.check_profile_bio(text) from public, anon, authenticated;
revoke all on function private.check_profile_text(text, text) from public, anon, authenticated;
revoke all on function private.check_clip_title(text) from public, anon, authenticated;
revoke all on function private.reject_objectionable_text() from public, anon, authenticated;
revoke all on function private.reject_if_suspended_actor() from public, anon, authenticated;

grant execute on function private.text_is_objectionable(text) to authenticated, service_role;
grant execute on function private.reject_objectionable_text() to authenticated, service_role;
grant execute on function private.reject_if_suspended_actor() to authenticated, service_role;

insert into public.moderation_terms (term, normalized, category)
select seed.term, private.canonical_term(seed.term), seed.category
from (
  values
    ('fuck', 'profanity'),
    ('shit', 'profanity'),
    ('bitch', 'profanity'),
    ('asshole', 'profanity'),
    ('bastard', 'profanity'),
    ('dick', 'profanity'),
    ('cunt', 'profanity'),
    ('porn', 'sexual'),
    ('nude', 'sexual'),
    ('hentai', 'sexual'),
    ('nigger', 'slur'),
    ('nigga', 'slur'),
    ('faggot', 'slur'),
    ('retard', 'slur'),
    ('tranny', 'slur'),
    ('kys', 'threat'),
    ('kill yourself', 'threat')
) as seed(term, category)
where private.canonical_term(seed.term) is not null;

create trigger profiles_reject_objectionable
  before insert or update on public.profiles
  for each row execute function private.reject_objectionable_text();

create trigger clips_reject_objectionable
  before insert or update on public.clips
  for each row execute function private.reject_objectionable_text();

create trigger clip_comments_reject_objectionable
  before insert or update on public.clip_comments
  for each row execute function private.reject_objectionable_text();

create trigger posts_reject_objectionable
  before insert or update on public.posts
  for each row execute function private.reject_objectionable_text();

create trigger messages_reject_objectionable
  before insert or update on public.messages
  for each row execute function private.reject_objectionable_text();

create trigger folders_reject_objectionable
  before insert or update on public.folders
  for each row execute function private.reject_objectionable_text();

create trigger conversations_reject_objectionable
  before insert or update on public.conversations
  for each row execute function private.reject_objectionable_text();

alter table public.profiles
  add column suspended_at timestamptz,
  add column suspended_reason text,
  add constraint profiles_suspended_reason_len check (
    suspended_reason is null or char_length(suspended_reason) between 1 and 200
  );

revoke update (suspended_at, suspended_reason) on table public.profiles from public, anon, authenticated;

create trigger profiles_reject_suspended
  before update on public.profiles
  for each row execute function private.reject_if_suspended_actor();

create trigger clips_reject_suspended
  before insert or update on public.clips
  for each row execute function private.reject_if_suspended_actor();

alter table public.messages
  add column removed_at timestamptz;

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_type text not null check (
    target_type in ('clip', 'comment', 'post', 'profile', 'message', 'screenshot')
  ),
  target_id uuid not null,
  target_user_id uuid references public.profiles (id) on delete set null,
  reason text not null check (
    reason in ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'impersonation', 'other')
  ),
  details text,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolution text,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint content_reports_details_len check (details is null or char_length(details) between 1 and 500),
  constraint content_reports_resolution_len check (
    resolution is null or char_length(resolution) between 1 and 500
  ),
  constraint content_reports_resolved_chk check (
    (status = 'open' and resolved_at is null and resolved_by is null)
    or (status <> 'open' and resolved_at is not null)
  )
);

create unique index content_reports_one_open
  on public.content_reports (reporter_id, target_type, target_id)
  where status = 'open';

create index content_reports_open_created_idx
  on public.content_reports (created_at)
  where status = 'open';

create index content_reports_target_user_idx on public.content_reports (target_user_id);

alter table public.content_reports enable row level security;
alter table public.content_reports force row level security;
revoke all on table public.content_reports from public, anon, authenticated;

insert into public.staff_permissions (key, category, label, description, sort) values
  ('moderation.view', 'moderation', 'View reports', 'Read the user-report queue.', 440),
  ('moderation.act', 'moderation', 'Resolve reports', 'Dismiss reports, remove content, and suspend accounts.', 450),
  ('moderation.terms', 'moderation', 'Manage filter terms', 'Add and retire objectionable-text terms.', 460);

insert into public.staff_role_permissions (role_id, permission_key) values
  ('00000000-0000-4000-8000-000000000002', 'moderation.view'),
  ('00000000-0000-4000-8000-000000000002', 'moderation.act'),
  ('00000000-0000-4000-8000-000000000002', 'moderation.terms');
