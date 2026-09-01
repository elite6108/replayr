import type { UtcDay } from "./analyticsDates";

export const PAID_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;
export const CHURNED_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"] as const;
export const ESTIMATED_MONTHLY_MRR_CENTS = 499;
export const ESTIMATED_YEARLY_MRR_CENTS = 399;
export const MIN_CORRELATION_SAMPLE = 10;

export type BillingInterval = "month" | "year" | "week" | "day";

export type SubscriptionSnapshot = {
  user_id: string;
  status: string;
  cancel_at_period_end: boolean;
  stripe_price_id?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  billing_interval?: string | null;
  interval_count?: number | null;
};

export function isPaidStatus(status: string): boolean {
  return (PAID_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

export function isChurnedStatus(status: string): boolean {
  return (CHURNED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

export function isScheduledToCancel(row: { status: string; cancel_at_period_end: boolean }): boolean {
  return isPaidStatus(row.status) && row.cancel_at_period_end;
}

export function classifyAccess(row: SubscriptionSnapshot | null, hasActiveGrant: boolean) {
  const paid = Boolean(row && isPaidStatus(row.status));
  return {
    paid,
    complimentary: hasActiveGrant,
    premium: paid || hasActiveGrant,
    pastDue: row?.status === "past_due",
    scheduledToCancel: row ? isScheduledToCancel(row) : false,
    expired: row?.status === "unpaid" || row?.status === "incomplete_expired",
    cancelled: row?.status === "canceled",
  };
}

export function monthlyRecurringCents(row: {
  amount_cents?: number | null;
  billing_interval?: string | null;
  interval_count?: number | null;
  stripe_price_id?: string | null;
  yearlyPriceId?: string | null;
}): { cents: number; authoritative: boolean } {
  const interval = row.billing_interval;
  const count = row.interval_count && row.interval_count > 0 ? row.interval_count : 1;
  if (row.amount_cents != null && row.amount_cents >= 0 && interval) {
    if (interval === "year") return { cents: Math.round(row.amount_cents / (12 * count)), authoritative: true };
    if (interval === "month") return { cents: Math.round(row.amount_cents / count), authoritative: true };
    if (interval === "week") return { cents: Math.round((row.amount_cents * 52) / (12 * count)), authoritative: true };
    if (interval === "day") return { cents: Math.round((row.amount_cents * 365) / (12 * count)), authoritative: true };
  }
  if (row.yearlyPriceId && row.stripe_price_id === row.yearlyPriceId) {
    return { cents: ESTIMATED_YEARLY_MRR_CENTS, authoritative: false };
  }
  return { cents: ESTIMATED_MONTHLY_MRR_CENTS, authoritative: false };
}

export function estimatedMrrCents(
  rows: SubscriptionSnapshot[],
  yearlyPriceId?: string | null,
): { estimated: number; authoritative: number | null; allAuthoritative: boolean } {
  let estimated = 0;
  let authoritative = 0;
  let missing = 0;
  for (const row of rows) {
    if (!isPaidStatus(row.status)) continue;
    const next = monthlyRecurringCents({ ...row, yearlyPriceId });
    estimated += next.cents;
    if (next.authoritative) authoritative += next.cents;
    else missing += 1;
  }
  const paidCount = rows.filter((row) => isPaidStatus(row.status)).length;
  return {
    estimated,
    authoritative: paidCount > 0 && missing === 0 ? authoritative : null,
    allAuthoritative: paidCount > 0 && missing === 0,
  };
}

export function estimatedArrCents(mrrCents: number | null): number | null {
  if (mrrCents == null) return null;
  return mrrCents * 12;
}

export function arpu(mrrCents: number | null, users: number | null): number | null {
  if (mrrCents == null || users == null || users <= 0) return null;
  return mrrCents / users;
}

export function subscriptionChurnRate(churned: number, paidAtStart: number | null): number | null {
  if (paidAtStart == null || paidAtStart <= 0) return null;
  return churned / paidAtStart;
}

export function detectSubscriptionTransition(
  previous: { status: string } | null,
  next: { status: string },
): "started" | "renewed" | "cancelled" | "expired" | "reactivated" | null {
  const wasPaid = previous ? isPaidStatus(previous.status) : false;
  const nowPaid = isPaidStatus(next.status);
  if (!previous) return nowPaid ? "started" : null;
  if (!wasPaid && nowPaid) return isChurnedStatus(previous.status) || previous.status === "past_due" ? "reactivated" : "started";
  if (wasPaid && !nowPaid) {
    if (next.status === "unpaid" || next.status === "incomplete_expired") return "expired";
    return "cancelled";
  }
  return null;
}

/** Paid within N days of origin. Immature origins are excluded. */
export function paidWithinDays(
  origins: Array<{ user_id: string; origin_at: string }>,
  firstPaidAt: Map<string, string>,
  windowDays: number,
  asOf: UtcDay,
): number | null {
  let eligible = 0;
  let converted = 0;
  const windowMs = windowDays * 86_400_000;
  for (const row of origins) {
    const origin = new Date(row.origin_at).getTime();
    const matureAt = origin + windowMs;
    if (new Date(`${asOf}T00:00:00.000Z`).getTime() <= matureAt) continue;
    eligible += 1;
    const paid = firstPaidAt.get(row.user_id);
    if (paid && new Date(paid).getTime() - origin <= windowMs && new Date(paid).getTime() >= origin) converted += 1;
  }
  if (eligible === 0) return null;
  return converted / eligible;
}

export function paidConversionAmong(
  userIds: Iterable<string>,
  paidIds: Set<string>,
  minSample = MIN_CORRELATION_SAMPLE,
): { users: number; paid: number; rate: number | null } {
  const ids = [...new Set(userIds)];
  const paid = ids.filter((id) => paidIds.has(id)).length;
  return {
    users: ids.length,
    paid,
    rate: ids.length >= minSample ? paid / ids.length : null,
  };
}

export function divideOrNull(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return numerator / denominator;
}
