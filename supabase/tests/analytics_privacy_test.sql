begin;

select plan(14);

select ok(
  not has_table_privilege('anon', 'public.analytics_events', 'select'),
  'anon cannot read raw analytics'
);
select ok(
  not has_table_privilege('authenticated', 'public.analytics_events', 'select'),
  'authenticated cannot read raw analytics'
);
select ok(
  not has_table_privilege('anon', 'public.audit_log', 'select'),
  'anon cannot read audit data'
);
select ok(
  not has_table_privilege('authenticated', 'public.audit_log', 'select'),
  'authenticated cannot read audit data'
);
select ok(
  not has_table_privilege('anon', 'public.user_analytics_preferences', 'select'),
  'anon cannot read analytics consent'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_analytics_preferences', 'select'),
  'authenticated cannot read analytics consent'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
      from pg_class
     where oid = 'public.user_analytics_preferences'::regclass
  ),
  'analytics consent uses forced RLS'
);
select ok(
  exists (
    select 1
      from pg_constraint
     where conrelid = 'public.analytics_events'::regclass
       and conname = 'analytics_events_no_direct_identity_check'
  ),
  'raw analytics forbids direct identity columns'
);
select ok(
  not exists (
    select 1 from public.analytics_events
     where user_id is not null or anonymous_id is not null
  ),
  'raw analytics contains no direct identities'
);
select ok(
  not exists (
    select 1 from public.analytics_events
     where properties ?| array['body', 'title', 'path', 'filename', 'storage_key', 'recipient_id']
  ),
  'raw analytics contains no forbidden content properties'
);
select ok(
  not has_function_privilege('anon', 'public.staff_guard_last_super_admin()', 'execute'),
  'anon cannot execute last-super-admin guard'
);
select ok(
  not has_function_privilege('authenticated', 'public.staff_guard_last_super_admin()', 'execute'),
  'authenticated cannot execute last-super-admin guard'
);
select ok(
  exists (select 1 from public.staff_permissions where key = 'analytics.users.view'),
  'named journeys have a dedicated permission'
);
select ok(
  not exists (
    select 1
      from public.staff_role_permissions srp
      join public.staff_roles sr on sr.id = srp.role_id
     where sr.slug = 'admin'
       and srp.permission_key = 'analytics.users.view'
  ),
  'named journey permission is not granted to admin by default'
);

select * from finish();
rollback;
