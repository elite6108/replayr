-- Add confirmed Replayr accounts to the waitlist (campaign audience).
-- Existing unsubscribed rows are left alone. No confirmation emails are sent.

insert into public.waitlist_emails (email, source)
select lower(trim(u.email)), 'account'
from auth.users u
where u.email is not null
  and trim(u.email) <> ''
  and (u.email_confirmed_at is not null or u.confirmed_at is not null)
  and not exists (
    select 1
    from public.waitlist_emails w
    where lower(trim(w.email)) = lower(trim(u.email))
  )
on conflict (email) do nothing;

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
  if new.email is not null and trim(new.email) <> '' then
    insert into public.waitlist_emails (email, source)
    values (lower(trim(new.email)), 'account')
    on conflict (email) do nothing;
  end if;
  return new;
end;
$$;
