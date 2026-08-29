-- Harden client access without changing unlisted share-link behavior.
-- Unlisted clips stay owner-readable via PostgREST and Worker-lookup-only
-- for everyone else. Never grant get_clip_for_playback to anon/authenticated.

-- ---------------------------------------------------------------------------
-- Schema + default privileges: new objects are service-role-only until a
-- later migration grants specific client columns.
-- ---------------------------------------------------------------------------

revoke all on schema public from public;
grant usage on schema public to anon, authenticated, service_role, authenticator;

-- Default privileges for the migration role (hosted Postgres cannot set them
-- for supabase_admin). New objects stay service-role-only until granted.
do $priv$
begin
  execute 'alter default privileges in schema public revoke all on tables from public, anon, authenticated';
  execute 'alter default privileges in schema public grant all on tables to service_role';
  execute 'alter default privileges in schema public revoke all on sequences from public, anon, authenticated';
  execute 'alter default privileges in schema public grant all on sequences to service_role';
  execute 'alter default privileges in schema public revoke all on functions from public, anon, authenticated';
  execute 'alter default privileges in schema public grant all on functions to service_role';
exception
  when insufficient_privilege then
    raise notice 'Skipping default privileges: %', sqlerrm;
end;
$priv$;

-- ---------------------------------------------------------------------------
-- Explicit deny policies for service-role-only tables (advisor 0008).
-- Grants already revoked; these document default-deny for PostgREST.
-- ---------------------------------------------------------------------------

drop policy if exists announcements_no_client on public.announcements;
create policy announcements_no_client on public.announcements
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists bunny_ingest_tokens_no_client on public.bunny_ingest_tokens;
create policy bunny_ingest_tokens_no_client on public.bunny_ingest_tokens
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists clip_comments_no_client on public.clip_comments;
create policy clip_comments_no_client on public.clip_comments
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists clip_daily_views_no_client on public.clip_daily_views;
create policy clip_daily_views_no_client on public.clip_daily_views
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists clip_likes_no_client on public.clip_likes;
create policy clip_likes_no_client on public.clip_likes
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists error_events_no_client on public.error_events;
create policy error_events_no_client on public.error_events
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists product_events_no_client on public.product_events;
create policy product_events_no_client on public.product_events
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists stripe_events_no_client on public.stripe_events;
create policy stripe_events_no_client on public.stripe_events
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists waitlist_emails_no_client on public.waitlist_emails;
create policy waitlist_emails_no_client on public.waitlist_emails
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists upload_sessions_owner_all on public.upload_sessions;
drop policy if exists upload_sessions_no_client on public.upload_sessions;
create policy upload_sessions_no_client on public.upload_sessions
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table public.upload_sessions from public, anon, authenticated;
grant all on table public.upload_sessions to service_role;

-- ---------------------------------------------------------------------------
-- clips: one SELECT policy (owner OR public+ready). Unlisted is not listable.
-- Owner UPDATE only — no INSERT/DELETE policies. Column grants re-asserted.
-- ---------------------------------------------------------------------------

drop policy if exists clips_owner_all on public.clips;
drop policy if exists clips_public_select on public.clips;
drop policy if exists clips_select on public.clips;
drop policy if exists clips_owner_update on public.clips;

create policy clips_select on public.clips
  for select
  using (
    user_id = (select auth.uid())
    or (visibility = 'public' and status = 'ready')
  );

create policy clips_owner_update on public.clips
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on table public.clips from public, anon, authenticated;
grant select (
  id, user_id, game_id, title, description, slug,
  duration_ms, width, height, fps, codec, file_size_bytes,
  visibility, status, created_at, updated_at, published_at,
  view_count, like_count, comment_count, share_count, download_count,
  watermark
) on table public.clips to anon, authenticated;
grant update (title, visibility, description)
  on table public.clips to authenticated;
grant all on table public.clips to service_role;

revoke all on function public.get_clip_for_playback(text) from public, anon, authenticated;
grant execute on function public.get_clip_for_playback(text) to service_role;

-- ---------------------------------------------------------------------------
-- Billing: cache auth.uid() once per statement.
-- ---------------------------------------------------------------------------

drop policy if exists billing_customers_select on public.billing_customers;
create policy billing_customers_select on public.billing_customers
  for select
  using (user_id = (select auth.uid()));

drop policy if exists billing_subscriptions_select on public.billing_subscriptions;
create policy billing_subscriptions_select on public.billing_subscriptions
  for select
  using (user_id = (select auth.uid()));

drop policy if exists billing_grants_select on public.billing_grants;
create policy billing_grants_select on public.billing_grants
  for select
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Freeze privileged columns if a later grant widens client UPDATE.
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_privileged_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    new.id := old.id;
    new.is_verified := old.is_verified;
    new.followers_count := old.followers_count;
    new.following_count := old.following_count;
    new.clip_count := old.clip_count;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create or replace function public.protect_clip_privileged_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    new.user_id := old.user_id;
    new.slug := old.slug;
    new.storage_key := old.storage_key;
    new.thumbnail_key := old.thumbnail_key;
    new.status := old.status;
    new.view_count := old.view_count;
    new.like_count := old.like_count;
    new.comment_count := old.comment_count;
    new.share_count := old.share_count;
    new.download_count := old.download_count;
    new.watermark := old.watermark;
    new.watermark_variant_status := old.watermark_variant_status;
    new.watermark_processor := old.watermark_processor;
    new.watermark_processor_video_id := old.watermark_processor_video_id;
    new.watermark_resolution := old.watermark_resolution;
    new.watermark_render_version := old.watermark_render_version;
    new.watermark_error := old.watermark_error;
    new.watermark_updated_at := old.watermark_updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileged on public.profiles;
create trigger profiles_protect_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_columns();

drop trigger if exists clips_protect_privileged on public.clips;
create trigger clips_protect_privileged
  before update on public.clips
  for each row execute function public.protect_clip_privileged_columns();

revoke all on function public.protect_profile_privileged_columns() from public, anon, authenticated;
revoke all on function public.protect_clip_privileged_columns() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- FORCE RLS on every public table. service_role has BYPASSRLS.
-- ---------------------------------------------------------------------------

alter table public.announcements force row level security;
alter table public.app_settings force row level security;
alter table public.billing_customers force row level security;
alter table public.billing_grants force row level security;
alter table public.billing_subscriptions force row level security;
alter table public.bunny_ingest_tokens force row level security;
alter table public.clip_comments force row level security;
alter table public.clip_daily_views force row level security;
alter table public.clip_likes force row level security;
alter table public.clips force row level security;
alter table public.conversation_clips force row level security;
alter table public.conversation_members force row level security;
alter table public.conversations force row level security;
alter table public.creator_applications force row level security;
alter table public.error_events force row level security;
alter table public.friendships force row level security;
alter table public.games force row level security;
alter table public.messages force row level security;
alter table public.notifications force row level security;
alter table public.plans force row level security;
alter table public.product_events force row level security;
alter table public.profiles force row level security;
alter table public.stripe_events force row level security;
alter table public.upload_sessions force row level security;
alter table public.user_storage force row level security;
alter table public.waitlist_emails force row level security;

-- ---------------------------------------------------------------------------
-- Covering indexes for unindexed foreign keys.
-- ---------------------------------------------------------------------------

create index if not exists billing_grants_user_id_idx
  on public.billing_grants (user_id);
create index if not exists billing_grants_granted_by_idx
  on public.billing_grants (granted_by);
create index if not exists clip_comments_user_id_idx
  on public.clip_comments (user_id);
create index if not exists conversation_clips_granted_by_idx
  on public.conversation_clips (granted_by);
create index if not exists conversations_created_by_idx
  on public.conversations (created_by);
create index if not exists conversations_dm_user_a_idx
  on public.conversations (dm_user_a);
create index if not exists conversations_dm_user_b_idx
  on public.conversations (dm_user_b);
create index if not exists friendships_blocked_by_idx
  on public.friendships (blocked_by);
create index if not exists friendships_requested_by_idx
  on public.friendships (requested_by);
create index if not exists messages_clip_id_idx
  on public.messages (clip_id);
create index if not exists messages_sender_id_idx
  on public.messages (sender_id);
create index if not exists notifications_actor_id_idx
  on public.notifications (actor_id);
create index if not exists notifications_conversation_id_idx
  on public.notifications (conversation_id);
create index if not exists notifications_friendship_id_idx
  on public.notifications (friendship_id);
create index if not exists notifications_message_id_idx
  on public.notifications (message_id);
create index if not exists stripe_events_user_id_idx
  on public.stripe_events (user_id);
create index if not exists upload_sessions_clip_id_idx
  on public.upload_sessions (clip_id);
create index if not exists user_storage_plan_id_idx
  on public.user_storage (plan_id);

-- ---------------------------------------------------------------------------
-- Supabase Storage is unused (video lives in R2). Drop client table grants.
-- ---------------------------------------------------------------------------

revoke all on table storage.objects from public, anon, authenticated;
revoke all on table storage.buckets from public, anon, authenticated;
revoke all on table storage.buckets_analytics from public, anon, authenticated;
revoke all on table storage.s3_multipart_uploads from public, anon, authenticated;
revoke all on table storage.s3_multipart_uploads_parts from public, anon, authenticated;
revoke all on table storage.buckets_vectors from public, anon, authenticated;
revoke all on table storage.vector_indexes from public, anon, authenticated;
