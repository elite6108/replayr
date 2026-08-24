-- RLS for social tables should not expose a SECURITY DEFINER RPC.
-- Membership is checked with EXISTS against conversation_members (own-row SELECT).

drop policy if exists conversations_select on public.conversations;
drop policy if exists conversation_members_select on public.conversation_members;
drop policy if exists messages_select on public.messages;
drop policy if exists conversation_clips_select on public.conversation_clips;

create policy conversation_members_select on public.conversation_members
  for select using (user_id = (select auth.uid()));

create policy conversations_select on public.conversations
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = conversations.id
        and cm.user_id = (select auth.uid())
    )
  );

create policy messages_select on public.messages
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id
        and cm.user_id = (select auth.uid())
    )
  );

create policy conversation_clips_select on public.conversation_clips
  for select using (
    exists (
      select 1
      from public.conversation_members cm
      where cm.conversation_id = conversation_clips.conversation_id
        and cm.user_id = (select auth.uid())
    )
  );

revoke all on function public.is_conversation_member(uuid) from public, anon, authenticated, service_role;
drop function if exists public.is_conversation_member(uuid);
