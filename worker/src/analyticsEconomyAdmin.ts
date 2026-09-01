import { ANALYTICS_METRIC_CATALOG, type MetricAvailability } from "./analyticsAvailability";
import { addUtcDays, comparisonPeriodRange, daysInRange, formatRangeLabel, serializeComparisonRange, utcDay, type UtcDay } from "./analyticsDates";
import { isWindowMature, uniqueActiveUsersInRange } from "./analyticsGrowth";
import {
  averageOrNull,
  forecastFromAverage,
  GIB,
  latestAssumption,
  monthlyStorageCostCents,
  storageSegments,
  topConsumers,
  validateCostRate,
  type CostAssumption,
} from "./analyticsInfrastructure";
import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import {
  ANALYTICS_ACTIVITY_AVAILABLE_FROM,
} from "./analyticsGrowth";
import {
  arpu,
  classifyAccess,
  divideOrNull,
  estimatedArrCents,
  estimatedMrrCents,
  isPaidStatus,
  MIN_CORRELATION_SAMPLE,
  paidConversionAmong,
  paidWithinDays,
  subscriptionChurnRate,
} from "./analyticsRevenue";
import {
  getActiveGrantUserIds,
  getBillingSubscriptions,
  getCostAssumptions,
  getFeatureUserIds,
  getFirstPaidRows,
  getFolderUserIds,
  getReadyClipCounts,
  getStorageDailySeries,
  getStorageUsers,
  getSubscriptionDailySeries,
  getUserActivityRows,
  getUserGameFirstRows,
  getUserMilestoneRows,
} from "./analyticsQueries";
import type { Env } from "./env";
import { HttpError } from "./http";
import { requireServiceRole, serviceRest } from "./shared";

function catalog(key: string) {
  const row = ANALYTICS_METRIC_CATALOG.find((item) => item.key === key);
  return { availability: (row?.availability ?? "NOT_INSTRUMENTED") as MetricAvailability, notes: row?.notes ?? "" };
}

function kpi(key: string, label: string, value: number | null, previous: number | null, extras: Partial<AnalyticsKpi> = {}): AnalyticsKpi {
  const meta = catalog(key);
  const current = extras.availability ?? meta.availability;
  return {
    key,
    label,
    value,
    previous,
    absoluteChange: value != null && previous != null ? value - previous : null,
    percentageChange:
      previous == null || previous === 0 ? (value != null && previous === 0 && value > 0 ? "new" : null) : (value! - previous) / previous,
    availability: current,
    badge: extras.badge ?? (current === "AVAILABLE_ESTIMATE" ? "estimate" : current === "INCOMPLETE" ? "incomplete" : current === "PROXY" ? "proxy" : null),
    tooltip: extras.tooltip ?? meta.notes,
    unit: extras.unit ?? "count",
    asOf: extras.asOf ?? null,
  };
}

function asOfDay(toExclusive: UtcDay, now = new Date()): UtcDay {
  const today = utcDay(now);
  const last = addUtcDays(toExclusive, -1);
  return last < today ? last : today;
}

function sum(rows: Array<Record<string, unknown>>, key: string): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = Number(row[key]);
    if (!Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function lastPresent(rows: Array<Record<string, unknown>>, key: string): { value: number; day: string } | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = Number(rows[i]?.[key]);
    if (Number.isFinite(value)) return { value, day: String(rows[i].day) };
  }
  return null;
}

function planSlug(value: { slug: string } | { slug: string }[] | null | undefined): string {
  if (!value) return "free";
  return Array.isArray(value) ? value[0]?.slug ?? "free" : value.slug;
}

export async function buildAnalyticsRevenue(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const previousRange = comparisonPeriodRange(query.comparison);
  const asOf = asOfDay(query.to);
  const [
    series,
    prevSeries,
    subs,
    grants,
    firstPaid,
    milestones,
    activity,
    featureUsers,
    gameFirsts,
    folders,
    startSnap,
  ] = await Promise.all([
    getSubscriptionDailySeries(env, { from: query.from, to: query.to }),
    previousRange ? getSubscriptionDailySeries(env, previousRange) : Promise.resolve(null),
    getBillingSubscriptions(env),
    getActiveGrantUserIds(env),
    getFirstPaidRows(env),
    getUserMilestoneRows(env, { environment: "production" }),
    getUserActivityRows(env, { from: addUtcDays(query.from, -90), to: query.to, environment: "production" }),
    getFeatureUserIds(
      env,
      [
        "pricing.viewed",
        "subscription.checkout_started",
        "clip.editor_opened",
        "visual.filter_applied",
        "clip.upload_completed",
        "clip.shared",
        "folder.public_link_enabled",
      ],
      { from: query.from, to: query.to, environment: "production" },
    ),
    getUserGameFirstRows(env),
    getFolderUserIds(env),
    getSubscriptionDailySeries(env, { from: addUtcDays(query.from, -1), to: query.from }),
  ]);
  const paidRows = subs.filter((row) => isPaidStatus(row.status));
  const paidIds = new Set(paidRows.map((row) => row.user_id));
  const mrr = estimatedMrrCents(paidRows, env.STRIPE_PRICE_PREMIUM_YEARLY);
  const prevPaid = prevSeries ? lastPresent(prevSeries.rows, "active_paid_subscribers_end_of_day") : null;
  const prevMrr = prevSeries ? lastPresent(prevSeries.rows, "estimated_mrr_cents") : null;
  const grantsEnd = lastPresent(series.rows, "active_grants_end_of_day") ?? lastPresent(series.rows, "active_grants");
  const livePaid = paidRows.length;
  const liveGrants = grants.size;
  const liveScheduled = paidRows.filter((row) => row.cancel_at_period_end).length;
  const livePastDue = subs.filter((row) => row.status === "past_due").length;
  const newPaid = sum(series.rows, "new_paid_subscribers");
  const cancelled = sum(series.rows, "cancelled_subscriptions") ?? 0;
  const expired = sum(series.rows, "expired_subscriptions") ?? 0;
  const reactivated = sum(series.rows, "reactivated_subscriptions");
  const paidAtStart = lastPresent(startSnap.rows, "active_paid_subscribers_end_of_day");
  const firstPaidMap = new Map(firstPaid.map((row) => [row.user_id, row.first_paid_at]));
  const signups = milestones
    .filter((row) => row.signup_at && row.signup_at >= `${query.from}T00:00:00.000Z` && row.signup_at < `${query.to}T00:00:00.000Z`)
    .map((row) => ({ user_id: row.user_id, origin_at: row.signup_at! }));
  const activations = milestones
    .filter((row) => row.activated_at && row.activated_at >= `${query.from}T00:00:00.000Z` && row.activated_at < `${query.to}T00:00:00.000Z`)
    .map((row) => ({ user_id: row.user_id, origin_at: row.activated_at! }));
  const mauMature = isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30, asOf);
  const dauMature = asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM;
  const activeDenom = mauMature
    ? uniqueActiveUsersInRange(activity, addUtcDays(asOf, -29), addUtcDays(asOf, 1))
    : dauMature
      ? uniqueActiveUsersInRange(activity, asOf, addUtcDays(asOf, 1))
      : null;
  const activeLabel = mauMature ? "MAU" : dauMature ? "DAU" : null;
  const folderUsers = folders.folderUsers;
  const collabUsers = folders.collaborators;
  const gameUsers = new Map<string, Set<string>>();
  for (const row of gameFirsts) {
    const set = gameUsers.get(row.game_slug) ?? new Set<string>();
    set.add(row.user_id);
    gameUsers.set(row.game_slug, set);
  }
  const labels = daysInRange(query.from, query.to);
  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated: series.rows.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      paid: "active or trialing Stripe subscription. Grants and past_due are excluded.",
      complimentary: "Active billing grant. Not a paid subscriber.",
      premium: "Paid or complimentary.",
      churn: "Cancelled + expired in the range / paid subscribers at period start. cancel_at_period_end is not churn.",
      mrr: "Estimated until every paid row has Stripe amount_cents. Not Revenue.",
    },
    snapshot: {
      paid: livePaid,
      complimentary: liveGrants,
      premium: new Set([...paidIds, ...grants]).size,
      scheduledToCancel: liveScheduled,
      pastDue: livePastDue,
      expired: subs.filter((row) => row.status === "unpaid" || row.status === "incomplete_expired").length,
      cancelled: subs.filter((row) => row.status === "canceled").length,
    },
    metrics: [
      kpi("paid_subscribers", "Paid Subscribers", livePaid, prevPaid?.value ?? null, { asOf: utcDay() }),
      kpi("new_paid_subscribers", "New Paid", newPaid, prevSeries ? sum(prevSeries.rows, "new_paid_subscribers") : null),
      kpi("scheduled_cancellations", "Scheduled to Cancel", liveScheduled, null, { asOf: utcDay() }),
      kpi("cancelled_subscriptions", "Cancelled / Expired", cancelled + expired, prevSeries ? (sum(prevSeries.rows, "cancelled_subscriptions") ?? 0) + (sum(prevSeries.rows, "expired_subscriptions") ?? 0) : null),
      kpi("complimentary_premium", "Complimentary Premium", liveGrants, grantsEnd?.value ?? null, { asOf: utcDay() }),
      kpi("estimated_mrr_cents", "Estimated MRR", mrr.estimated, prevMrr?.value ?? null, { unit: "cents" }),
      kpi("estimated_arr_cents", "Estimated ARR", estimatedArrCents(mrr.estimated), prevMrr ? estimatedArrCents(prevMrr.value) : null, { unit: "cents" }),
      kpi("free_to_paid_7d", "Signup → Paid (7d)", paidWithinDays(signups, firstPaidMap, 7, asOf), null, { unit: "percent" }),
      kpi("subscription_churn_rate", "Churn", subscriptionChurnRate(cancelled + expired, paidAtStart?.value ?? null), null, { unit: "percent" }),
      kpi("arpu", `ARPU (${activeLabel ?? "unavailable"})`, arpu(mrr.estimated, activeDenom), null, { unit: "cents" }),
      kpi("arppu", "ARPPU", arpu(mrr.estimated, livePaid), null, { unit: "cents" }),
    ],
    funnel: [
      { name: "Pricing viewed", count: featureUsers.get("pricing.viewed")?.size ?? null, availability: "INCOMPLETE" },
      { name: "Checkout started", count: featureUsers.get("subscription.checkout_started")?.size ?? null, availability: "INCOMPLETE" },
      { name: "Checkout completed", count: newPaid, availability: "INCOMPLETE" },
      { name: "Active paid", count: livePaid, availability: "AVAILABLE" },
    ],
    conversion: {
      signup7d: paidWithinDays(signups, firstPaidMap, 7, asOf),
      activation7d: paidWithinDays(activations, firstPaidMap, 7, asOf),
      activation30d: paidWithinDays(activations, firstPaidMap, 30, asOf),
      note: "Cohort-based. Immature windows are null. Not same-week subscriptions / same-week signups.",
    },
    correlations: [
      { key: "editor", label: "Editor users", ...paidConversionAmong(featureUsers.get("clip.editor_opened") ?? [], paidIds) },
      { key: "filters", label: "Filter users", ...paidConversionAmong(featureUsers.get("visual.filter_applied") ?? [], paidIds) },
      { key: "upload", label: "Cloud uploaders", ...paidConversionAmong(featureUsers.get("clip.upload_completed") ?? [], paidIds) },
      { key: "share", label: "Sharers", ...paidConversionAmong(featureUsers.get("clip.shared") ?? [], paidIds) },
      { key: "folders", label: "Folder users", ...paidConversionAmong(folderUsers, paidIds) },
      { key: "collaborators", label: "Collaborators", ...paidConversionAmong(collabUsers, paidIds) },
      ...[...gameUsers.entries()]
        .map(([slug, users]) => ({ key: `game:${slug}`, label: `First game ${slug}`, ...paidConversionAmong(users, paidIds) }))
        .filter((row) => row.users >= MIN_CORRELATION_SAMPLE || row.users > 0)
        .slice(0, 8),
    ].map((row) => ({
      ...row,
      note: row.rate == null ? `Need ${MIN_CORRELATION_SAMPLE} users. Observed correlation, not causation.` : "Observed correlation, not causation.",
    })),
    reactivations: reactivated,
    mrr: {
      estimatedCents: mrr.estimated,
      authoritativeCents: mrr.authoritative,
      isEstimate: true,
      allAuthoritative: mrr.allAuthoritative,
    },
    series: {
      labels,
      paid: labels.map((day) => numOn(series.rows, day, "active_paid_subscribers_end_of_day")),
      mrr: labels.map((day) => numOn(series.rows, day, "estimated_mrr_cents")),
      newPaid: labels.map((day) => numOn(series.rows, day, "new_paid_subscribers")),
      cancelled: labels.map((day) => numOn(series.rows, day, "cancelled_subscriptions")),
    },
  };
}

function numOn(rows: Array<Record<string, unknown>>, day: string, key: string): number | null {
  const row = rows.find((item) => String(item.day) === day);
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : null;
}

export async function buildAnalyticsInfrastructure(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const previousRange = comparisonPeriodRange(query.comparison);
  const asOf = asOfDay(query.to);
  const [storage, prev, users, clips, subs, grants, assumptions, activity, milestones] = await Promise.all([
    getStorageDailySeries(env, { from: query.from, to: query.to }),
    previousRange ? getStorageDailySeries(env, previousRange) : Promise.resolve(null),
    getStorageUsers(env),
    getReadyClipCounts(env),
    getBillingSubscriptions(env),
    getActiveGrantUserIds(env),
    getCostAssumptions(env),
    getUserActivityRows(env, { from: addUtcDays(query.from, -90), to: query.to, environment: "production" }),
    getUserMilestoneRows(env, { environment: "production" }),
  ]);
  const lastActive = new Map(milestones.map((row) => [row.user_id, row.last_active_at]));
  const classified = users.map((row) => {
    const access = classifyAccess(subs.find((item) => item.user_id === row.user_id) ?? null, grants.has(row.user_id));
    return {
      user_id: row.user_id,
      storage_used_bytes: Number(row.storage_used_bytes || 0),
      plan_slug: planSlug(row.plans),
      ready_clips: clips.get(row.user_id) ?? 0,
      last_active_at: lastActive.get(row.user_id) ?? null,
      paid: access.paid,
      complimentary: access.complimentary && !access.paid,
    };
  });
  const totalBytes = classified.reduce((sum, row) => sum + row.storage_used_bytes, 0);
  const readyClips = classified.reduce((sum, row) => sum + row.ready_clips, 0);
  const cloudUsers = classified.filter((row) => row.storage_used_bytes > 0 || row.ready_clips > 0);
  const paidUsers = classified.filter((row) => row.paid);
  const freeUsers = classified.filter((row) => !row.paid && !row.complimentary);
  const grantUsers = classified.filter((row) => row.complimentary);
  const added = sum(storage.rows, "storage_bytes_added");
  const deleted = sum(storage.rows, "storage_bytes_deleted");
  const eod = lastPresent(storage.rows, "total_storage_bytes_end_of_day");
  const r2 = latestAssumption(assumptions as CostAssumption[], "r2", "storage", asOf);
  const storageCost = monthlyStorageCostCents(totalBytes, r2 ? Number(r2.rate) : null);
  const addedDays = storage.rows
    .map((row) => Number(row.storage_bytes_added))
    .filter((value) => Number.isFinite(value));
  const forecast30 = forecastFromAverage(addedDays, 30);
  const forecast90 = forecastFromAverage(addedDays, 90);
  const mauMature = isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30, asOf);
  const active = mauMature
    ? uniqueActiveUsersInRange(activity, addUtcDays(asOf, -29), addUtcDays(asOf, 1))
    : asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM
      ? uniqueActiveUsersInRange(activity, asOf, addUtcDays(asOf, 1))
      : null;
  const activeLabel = mauMature ? "MAU" : asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM ? "DAU" : null;
  const mrr = estimatedMrrCents(
    subs.filter((row) => isPaidStatus(row.status)),
    env.STRIPE_PRICE_PREMIUM_YEARLY,
  );
  const labels = daysInRange(query.from, query.to);
  const planEconomics = [
    { key: "free", label: "Free", rows: freeUsers },
    { key: "paid", label: "Paid", rows: paidUsers },
    { key: "complimentary", label: "Complimentary", rows: grantUsers },
  ].map((group) => {
    const bytes = group.rows.reduce((sum, row) => sum + row.storage_used_bytes, 0);
    const clipsTotal = group.rows.reduce((sum, row) => sum + row.ready_clips, 0);
    const cost = monthlyStorageCostCents(bytes, r2 ? Number(r2.rate) : null);
    return {
      key: group.key,
      label: group.label,
      users: group.rows.length,
      averageStorageBytes: averageOrNull(bytes, group.rows.length),
      averageClips: averageOrNull(clipsTotal, group.rows.length),
      estimatedMonthlyCostCents: cost,
    };
  });
  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    lastUpdated: storage.rows.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    scope: "original_cloud_media_only",
    definitions: {
      storage: "Original cloud MP4 quota only. Not thumbnails or Bunny derivatives.",
      deleted: "Soft-deletes by updated_at when present. Net growth is left null.",
      bandwidth: "Not ingested from R2 or Bunny.",
      forecast: "Average daily storage added × horizon. Gross-growth estimate because deletes are incomplete.",
    },
    metrics: [
      kpi("total_storage_bytes_end_of_day", "Total Cloud Storage", eod?.value ?? totalBytes, prev ? lastPresent(prev.rows, "total_storage_bytes_end_of_day")?.value ?? null : null, {
        unit: "bytes",
        asOf: eod?.day ?? utcDay(),
        availability: "AVAILABLE",
      }),
      kpi("storage_bytes_added", "Storage Added", added, prev ? sum(prev.rows, "storage_bytes_added") : null, {
        unit: "bytes",
        availability: "AVAILABLE",
      }),
      kpi("storage_bytes_deleted", "Storage Deleted", deleted, prev ? sum(prev.rows, "storage_bytes_deleted") : null, { unit: "bytes" }),
      kpi("net_storage_change_bytes", "Net Growth", null, null, { unit: "bytes", availability: "INCOMPLETE" }),
      kpi("ready_cloud_clips", "Ready Cloud Clips", readyClips, null, { availability: "AVAILABLE" }),
      kpi("average_clip_bytes", "Average Clip Size", averageOrNull(totalBytes, readyClips), null, { unit: "bytes", availability: "AVAILABLE" }),
      kpi("storage_per_cloud_user", "Avg Storage / Cloud User", averageOrNull(totalBytes, cloudUsers.length), null, {
        unit: "bytes",
        availability: "AVAILABLE",
      }),
      kpi("storage_per_paid_user", "Avg Storage / Paid User", averageOrNull(
        paidUsers.reduce((sum, row) => sum + row.storage_used_bytes, 0),
        paidUsers.length,
      ), null, { unit: "bytes", availability: "AVAILABLE" }),
      kpi("infra_cost_monthly_cents", "Estimated Monthly Storage Cost", storageCost, null, { unit: "cents" }),
      kpi("bandwidth_cost", "Bandwidth Cost", null, null, { availability: "NOT_INSTRUMENTED" }),
      kpi("infra_cost_per_active_user", `Infra / ${activeLabel ?? "Active"}`, divideOrNull(storageCost, active), null, { unit: "cents" }),
      kpi("infra_cost_per_paid_user", "Infra / Paid User", divideOrNull(storageCost, paidUsers.length || null), null, { unit: "cents" }),
    ],
    margin: {
      estimatedMrrCents: mrr.estimated,
      estimatedVariableInfraCents: storageCost,
      estimatedGrossInfrastructureMarginCents:
        storageCost == null ? null : mrr.estimated - storageCost,
      note: "Estimated MRR minus estimated variable storage cost. Not gross profit. Excludes staff, taxes, software, marketing, and payment fees.",
    },
    segments: storageSegments(classified),
    topConsumers: topConsumers(classified).map((row) => ({
      userId: row.user_id,
      plan: row.plan_slug,
      storageBytes: row.storage_used_bytes,
      readyClips: row.ready_clips,
      lastActiveAt: row.last_active_at,
      access: row.paid ? "paid" : row.complimentary ? "complimentary" : "free",
    })),
    planEconomics,
    assumptions: assumptions.map((row) => ({
      id: row.id,
      provider: row.provider,
      metric: row.metric,
      unit: row.unit,
      rate: Number(row.rate),
      currency: row.currency,
      effectiveFrom: row.effective_from,
      notes: row.notes,
    })),
    forecast: {
      storageAdded30: forecast30,
      storageAdded90: forecast90,
      cost30Cents: forecast30 != null && r2 ? monthlyStorageCostCents((eod?.value ?? totalBytes) + forecast30, Number(r2.rate)) : null,
      cost90Cents: forecast90 != null && r2 ? monthlyStorageCostCents((eod?.value ?? totalBytes) + forecast90, Number(r2.rate)) : null,
      note: "Estimate based on current growth/rates. Uses storage added only; deletes are incomplete.",
    },
    series: {
      labels,
      added: labels.map((day) => numOn(storage.rows, day, "storage_bytes_added")),
      total: labels.map((day) => numOn(storage.rows, day, "total_storage_bytes_end_of_day")),
    },
  };
}

export async function patchCostAssumption(
  env: Env,
  body: { id?: unknown; provider?: unknown; metric?: unknown; unit?: unknown; rate?: unknown; currency?: unknown; effectiveFrom?: unknown; notes?: unknown },
  actor?: { actorId: string; requestId: string | null },
) {
  requireServiceRole(env);
  let rate: number;
  try {
    rate = validateCostRate(body.rate);
  } catch {
    throw new HttpError(400, "Rate must be a non-negative number.");
  }
  const currency = typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().slice(0, 8) : "USD";
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 400) : null;
  if (typeof body.id === "string") {
    const previous = await serviceRest<Array<{ id: string; provider: string; metric: string; rate: number }>>(
      env,
      "GET",
      `/analytics_cost_assumptions?id=eq.${body.id}&select=id,provider,metric,rate`,
    );
    const rows = await serviceRest<Array<{ id: string; provider: string; metric: string; rate: number }>>(
      env,
      "PATCH",
      `/analytics_cost_assumptions?id=eq.${body.id}`,
      { rate, currency, notes, updated_at: new Date().toISOString() },
      "return=representation",
    );
    if (!rows[0]) throw new HttpError(404, "That cost assumption was not found.");
    console.log("analytics_cost_assumption_updated", body.id, rate);
    if (actor) {
      const { AUDIT_ACTIONS, writeAuditLog } = await import("./audit");
      await writeAuditLog(env, {
        actorUserId: actor.actorId,
        actorType: "admin",
        action: AUDIT_ACTIONS.adminConfigChanged,
        targetType: "cost_assumption",
        targetId: body.id,
        requestId: actor.requestId,
        metadata: {
          provider: rows[0].provider,
          metric: rows[0].metric,
          from: previous[0] ? Number(previous[0].rate) : null,
          to: rate,
        },
      });
    }
    return rows[0];
  }
  const provider = typeof body.provider === "string" ? body.provider.trim().slice(0, 40) : "";
  const metric = typeof body.metric === "string" ? body.metric.trim().slice(0, 40) : "";
  const unit = typeof body.unit === "string" ? body.unit.trim().slice(0, 40) : "";
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : utcDay();
  if (!provider || !metric || !unit) throw new HttpError(400, "provider, metric, and unit are required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new HttpError(400, "effectiveFrom must be YYYY-MM-DD.");
  const rows = await serviceRest<Array<{ id: string }>>(
    env,
    "POST",
    "/analytics_cost_assumptions",
    {
      provider,
      metric,
      unit,
      rate,
      currency,
      effective_from: effectiveFrom,
      notes,
    },
    "return=representation",
  );
  console.log("analytics_cost_assumption_created", provider, metric, rate);
  if (actor) {
    const { AUDIT_ACTIONS, writeAuditLog } = await import("./audit");
    await writeAuditLog(env, {
      actorUserId: actor.actorId,
      actorType: "admin",
      action: AUDIT_ACTIONS.adminConfigChanged,
      targetType: "cost_assumption",
      targetId: rows[0]?.id ?? null,
      requestId: actor.requestId,
      metadata: { provider, metric, from: null, to: rate },
    });
  }
  return rows[0];
}
