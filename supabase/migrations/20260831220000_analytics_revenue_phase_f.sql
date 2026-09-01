-- Phase F: revenue + infrastructure economics.
-- Observational. Does not invent Stripe amounts or deletion ledgers.

alter table public.billing_subscriptions
  add column if not exists created_at timestamptz,
  add column if not exists amount_cents integer,
  add column if not exists currency text,
  add column if not exists billing_interval text,
  add column if not exists interval_count integer;

alter table public.analytics_subscription_daily
  add column if not exists active_grants_end_of_day bigint,
  add column if not exists scheduled_cancellations bigint,
  add column if not exists past_due_subscribers bigint,
  add column if not exists authoritative_mrr_cents bigint;

create table if not exists public.analytics_user_paid_first (
  user_id uuid primary key,
  first_paid_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics_cost_assumptions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  metric text not null,
  unit text not null,
  rate numeric not null check (rate >= 0),
  currency text not null default 'USD',
  effective_from date not null,
  notes text,
  updated_at timestamptz not null default now()
);

create unique index if not exists analytics_cost_assumptions_unique
  on public.analytics_cost_assumptions (provider, metric, effective_from);

insert into public.analytics_cost_assumptions (provider, metric, unit, rate, currency, effective_from, notes)
values
  ('r2', 'storage', 'gb_month', 0.015, 'USD', date '2026-08-31', 'Cloudflare R2 storage list price seed. Admin-editable. Original cloud media only.'),
  ('r2', 'egress', 'gb', 0, 'USD', date '2026-08-31', 'R2 egress is not ingested. Rate 0 until a provider feed exists.'),
  ('bunny', 'bandwidth', 'gb', 0, 'USD', date '2026-08-31', 'Bunny bandwidth is not ingested. Do not treat 0 as measured usage.')
on conflict (provider, metric, effective_from) do nothing;

create or replace function public.rollup_analytics_revenue_days(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  db_env text := public.analytics_environment();
  ev text;
  d date;
  days int := 0;
  today date := (timezone('utc', now()))::date;
  v_paid bigint;
  v_grants bigint;
  v_scheduled bigint;
  v_past_due bigint;
  v_mrr bigint;
  v_auth_mrr bigint;
  v_missing int;
  v_new bigint;
  v_cancelled bigint;
  v_expired bigint;
  v_reactivated bigint;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Range must be [from, to) with to after from.';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'Analytics backfill is limited to 366 days.';
  end if;

  insert into public.analytics_user_paid_first (user_id, first_paid_at, updated_at)
  select user_id, min(occurred_at), now()
    from public.analytics_events
   where event_name in ('subscription.started', 'subscription.reactivated')
     and user_id is not null
   group by user_id
  on conflict (user_id) do update set
    first_paid_at = least(public.analytics_user_paid_first.first_paid_at, excluded.first_paid_at),
    updated_at = now();

  insert into public.analytics_user_paid_first (user_id, first_paid_at, updated_at)
  select user_id, min(created_at), now()
    from public.stripe_events
   where type = 'customer.subscription.created'
     and user_id is not null
     and created_at is not null
   group by user_id
  on conflict (user_id) do update set
    first_paid_at = least(public.analytics_user_paid_first.first_paid_at, excluded.first_paid_at),
    updated_at = now();

  insert into public.analytics_user_paid_first (user_id, first_paid_at, updated_at)
  select user_id, min(created_at), now()
    from public.billing_subscriptions
   where status in ('active', 'trialing')
     and created_at is not null
   group by user_id
  on conflict (user_id) do update set
    first_paid_at = least(public.analytics_user_paid_first.first_paid_at, excluded.first_paid_at),
    updated_at = now();

  foreach ev in array array['production', 'development'] loop
    d := p_from;
    while d < p_to loop
      select
        count(*) filter (where event_name = 'subscription.started'),
        count(*) filter (where event_name = 'subscription.cancelled'),
        count(*) filter (where event_name = 'subscription.expired'),
        count(*) filter (where event_name = 'subscription.reactivated')
        into v_new, v_cancelled, v_expired, v_reactivated
      from public.analytics_events
      where environment = ev
        and occurred_at >= d
        and occurred_at < (d + 1)
        and event_name in ('subscription.started', 'subscription.cancelled', 'subscription.expired', 'subscription.reactivated');

      if ev = db_env then
        if coalesce(v_new, 0) = 0 then
          select count(*) into v_new
            from public.stripe_events
           where type = 'customer.subscription.created'
             and created_at >= d
             and created_at < (d + 1);
        end if;
        if coalesce(v_cancelled, 0) = 0 then
          select count(*) into v_cancelled
            from public.stripe_events
           where type = 'customer.subscription.deleted'
             and created_at >= d
             and created_at < (d + 1);
        end if;
      end if;

      if ev = db_env and d = today then
        select count(*) into v_paid
          from public.billing_subscriptions
         where status in ('active', 'trialing');
        select count(*) into v_scheduled
          from public.billing_subscriptions
         where status in ('active', 'trialing')
           and cancel_at_period_end;
        select count(*) into v_past_due
          from public.billing_subscriptions
         where status = 'past_due';
        select count(*) into v_grants
          from public.billing_grants
         where revoked_at is null
           and (expires_at is null or expires_at >= (d + 1));
        select
          coalesce(sum(
            case
              when amount_cents is not null and billing_interval = 'year'
                then round(amount_cents / (12.0 * greatest(coalesce(interval_count, 1), 1)))
              when amount_cents is not null and billing_interval = 'month'
                then round(amount_cents / greatest(coalesce(interval_count, 1), 1))
              when stripe_price_id is not null and stripe_price_id like '%year%' then 399
              else 499
            end
          ), 0),
          count(*) filter (where amount_cents is null)
          into v_mrr, v_missing
          from public.billing_subscriptions
         where status in ('active', 'trialing');
        v_auth_mrr := case when v_missing = 0 then v_mrr else null end;
      else
        v_paid := null;
        v_scheduled := null;
        v_past_due := null;
        v_grants := null;
        v_mrr := null;
        v_auth_mrr := null;
      end if;

      insert into public.analytics_subscription_daily (
        day, environment, active_paid_subscribers_end_of_day, new_paid_subscribers,
        cancelled_subscriptions, expired_subscriptions, reactivated_subscriptions,
        active_grants, active_grants_end_of_day, scheduled_cancellations, past_due_subscribers,
        estimated_mrr_cents, authoritative_mrr_cents, mrr_is_estimate, updated_at
      ) values (
        d, ev, v_paid, v_new, v_cancelled, v_expired, v_reactivated,
        v_grants, v_grants, v_scheduled, v_past_due,
        v_mrr, v_auth_mrr, true, now()
      )
      on conflict (day, environment) do update set
        active_paid_subscribers_end_of_day = coalesce(excluded.active_paid_subscribers_end_of_day, public.analytics_subscription_daily.active_paid_subscribers_end_of_day),
        new_paid_subscribers = excluded.new_paid_subscribers,
        cancelled_subscriptions = excluded.cancelled_subscriptions,
        expired_subscriptions = excluded.expired_subscriptions,
        reactivated_subscriptions = excluded.reactivated_subscriptions,
        active_grants = coalesce(excluded.active_grants, public.analytics_subscription_daily.active_grants),
        active_grants_end_of_day = coalesce(excluded.active_grants_end_of_day, public.analytics_subscription_daily.active_grants_end_of_day),
        scheduled_cancellations = coalesce(excluded.scheduled_cancellations, public.analytics_subscription_daily.scheduled_cancellations),
        past_due_subscribers = coalesce(excluded.past_due_subscribers, public.analytics_subscription_daily.past_due_subscribers),
        estimated_mrr_cents = coalesce(excluded.estimated_mrr_cents, public.analytics_subscription_daily.estimated_mrr_cents),
        authoritative_mrr_cents = coalesce(excluded.authoritative_mrr_cents, public.analytics_subscription_daily.authoritative_mrr_cents),
        mrr_is_estimate = true,
        updated_at = now();

      days := days + 1;
      d := d + 1;
    end loop;
  end loop;

  return days;
end;
$$;

alter table public.analytics_user_paid_first enable row level security;
alter table public.analytics_cost_assumptions enable row level security;
alter table public.analytics_user_paid_first force row level security;
alter table public.analytics_cost_assumptions force row level security;
revoke all on table public.analytics_user_paid_first from public, anon, authenticated;
revoke all on table public.analytics_cost_assumptions from public, anon, authenticated;
grant select, insert, update, delete on table public.analytics_user_paid_first to service_role;
grant select, insert, update, delete on table public.analytics_cost_assumptions to service_role;
revoke all on function public.rollup_analytics_revenue_days(date, date) from public, anon, authenticated;
grant execute on function public.rollup_analytics_revenue_days(date, date) to service_role;

insert into public.analytics_metric_catalog (metric_key, availability, notes, available_from) values
  ('paid_subscribers', 'AVAILABLE', 'billing_subscriptions status active or trialing. Grants and past_due are excluded.', null),
  ('complimentary_premium', 'AVAILABLE', 'Active billing_grants. Not paid subscribers.', null),
  ('premium_users', 'AVAILABLE', 'Paid or active grant. Labeled separately from paid.', null),
  ('scheduled_cancellations', 'AVAILABLE', 'Paid subscriptions with cancel_at_period_end. Still counted as paid until access ends.', null),
  ('new_paid_subscribers', 'INCOMPLETE', 'subscription.started or stripe customer.subscription.created. Pre-instrumentation history is incomplete.', '2026-08-31'),
  ('cancelled_subscriptions', 'INCOMPLETE', 'subscription.cancelled or stripe customer.subscription.deleted. cancel_at_period_end is not churn.', '2026-08-31'),
  ('subscription_churn_rate', 'INCOMPLETE', 'Cancelled+expired in range / paid at period start. Null without a start snapshot.', null),
  ('estimated_mrr_cents', 'AVAILABLE_ESTIMATE', 'Monthly recurring estimate. Uses Stripe amount_cents when present, else $4.99 / $3.99. Not Revenue.', null),
  ('estimated_arr_cents', 'AVAILABLE_ESTIMATE', 'Estimated MRR × 12. Not Revenue.', null),
  ('authoritative_mrr_cents', 'INCOMPLETE', 'Only when every paid subscriber has amount_cents from Stripe.', null),
  ('free_to_paid_7d', 'INCOMPLETE', 'Signup cohort that paid within 7 days. Not same-week mix.', '2026-09-07'),
  ('arpu', 'INCOMPLETE', 'Estimated MRR / active users. Hidden until the chosen denominator is mature.', '2026-08-31'),
  ('arppu', 'AVAILABLE_ESTIMATE', 'Estimated MRR / paid subscribers when paid > 0.', null),
  ('infra_cost_monthly_cents', 'AVAILABLE_ESTIMATE', 'Storage bytes × configured R2 gb_month rate. Bandwidth is not measured.', null),
  ('infra_cost_per_active_user', 'INCOMPLETE', 'Estimated monthly storage cost / active users when the denominator is mature.', '2026-08-31'),
  ('bandwidth_cost', 'NOT_INSTRUMENTED', 'No R2 or Bunny bandwidth feed. Do not show as 0 usage.', null),
  ('storage_bytes_deleted', 'INCOMPLETE', 'Soft-deletes only. Net growth is not fabricated.', null),
  ('storage_forecast', 'AVAILABLE_ESTIMATE', 'Recent average daily storage added × 30/90. Gross-growth estimate because deletes are incomplete.', null),
  ('infra_cost_per_paid_user', 'AVAILABLE_ESTIMATE', 'Estimated monthly storage cost / paid subscribers.', null),
  ('ready_cloud_clips', 'AVAILABLE', 'Ready original cloud clips. Not derivatives.', null),
  ('average_clip_bytes', 'AVAILABLE', 'Total original cloud bytes / ready clips.', null),
  ('storage_per_cloud_user', 'AVAILABLE', 'Original cloud quota / users with storage or ready clips.', null),
  ('storage_per_paid_user', 'AVAILABLE', 'Original cloud quota / paid subscribers.', null)
on conflict (metric_key) do update set
  availability = excluded.availability,
  notes = excluded.notes,
  available_from = excluded.available_from;
