-- Waitlist rows for new accounts are added only after the email is confirmed.
-- Existing unsubscribed rows are left alone. No confirmation emails are sent.

create or replace function public.add_account_to_waitlist(account_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if account_email is null or trim(account_email) = '' then
    return;
  end if;
  insert into public.waitlist_emails (email, source)
  values (lower(trim(account_email)), 'account')
  on conflict (email) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  free_plan public.plans%rowtype;
begin
  select * into strict free_plan from public.plans where slug = 'free';
  insert into public.profiles (id) values (new.id);
  insert into public.user_storage (user_id, plan_id, storage_used_bytes, storage_limit_bytes)
  values (new.id, free_plan.id, 0, free_plan.storage_limit_bytes);
  if new.email_confirmed_at is not null then
    perform public.add_account_to_waitlist(new.email);
  end if;
  return new;
end;
$$;

create or replace function public.sync_waitlist_on_email_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    perform public.add_account_to_waitlist(new.email);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  execute function public.sync_waitlist_on_email_confirm();

revoke execute on function public.add_account_to_waitlist(text) from public, anon, authenticated;
revoke execute on function public.sync_waitlist_on_email_confirm() from public, anon, authenticated;
grant execute on function public.add_account_to_waitlist(text) to supabase_auth_admin;
grant execute on function public.sync_waitlist_on_email_confirm() to supabase_auth_admin;
