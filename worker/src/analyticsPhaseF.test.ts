import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "./admin";
import { parseClientAnalyticsEvents } from "./analytics";
import { metricAvailability } from "./analyticsAvailability";
import { parseAdminAnalyticsQuery } from "./analyticsAdmin";
import { resolveComparisonPeriod } from "./analyticsDates";
import { isAuthoritativeFinancialEvent, isServerAuthoritativeEvent } from "./analyticsDictionary";
import {
  averageOrNull,
  forecastFromAverage,
  GIB,
  latestAssumption,
  monthlyStorageCostCents,
  storageBucket,
  storageSegments,
  topConsumers,
  validateCostRate,
} from "./analyticsInfrastructure";
import {
  classifyAccess,
  detectSubscriptionTransition,
  divideOrNull,
  estimatedArrCents,
  estimatedMrrCents,
  isPaidStatus,
  isScheduledToCancel,
  monthlyRecurringCents,
  paidConversionAmong,
  paidWithinDays,
  subscriptionChurnRate,
} from "./analyticsRevenue";
import { stripeRecurringPrice } from "./billing";
import type { Env } from "./env";
import { HttpError } from "./http";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const USER_C = "33333333-3333-4333-8333-333333333333";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
    ...overrides,
  };
}

function forbiddenFinanceKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|webhook_secret|sk_live|object_key|storage_key|thumbnail_key|stripe_secret/i.test(key)) {
      found.push(key);
    }
    forbiddenFinanceKeys(child, found);
  }
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("paid vs grant", () => {
  it("keeps paid, grant, and premium separate", () => {
    const paid = classifyAccess({ user_id: USER_A, status: "active", cancel_at_period_end: false }, false);
    const grant = classifyAccess(null, true);
    const both = classifyAccess({ user_id: USER_B, status: "trialing", cancel_at_period_end: false }, true);
    const pastDue = classifyAccess({ user_id: USER_C, status: "past_due", cancel_at_period_end: false }, false);
    expect(paid.paid).toBe(true);
    expect(paid.complimentary).toBe(false);
    expect(paid.premium).toBe(true);
    expect(grant.paid).toBe(false);
    expect(grant.complimentary).toBe(true);
    expect(grant.premium).toBe(true);
    expect(both.premium).toBe(true);
    expect(pastDue.paid).toBe(false);
    expect(pastDue.pastDue).toBe(true);
    expect(isPaidStatus("past_due")).toBe(false);
    expect([paid, grant, both].filter((row) => row.premium).length).toBe(3);
  });

  it("does not treat cancel_at_period_end as churned", () => {
    const row = { user_id: USER_A, status: "active", cancel_at_period_end: true };
    expect(isScheduledToCancel(row)).toBe(true);
    expect(isPaidStatus(row.status)).toBe(true);
    expect(classifyAccess(row, false).cancelled).toBe(false);
  });

  it("counts expired separately from cancelled", () => {
    expect(detectSubscriptionTransition({ status: "active" }, { status: "canceled" })).toBe("cancelled");
    expect(detectSubscriptionTransition({ status: "active" }, { status: "unpaid" })).toBe("expired");
    expect(detectSubscriptionTransition({ status: "trialing" }, { status: "incomplete_expired" })).toBe("expired");
  });

  it("detects reactivation after cancel or past_due", () => {
    expect(detectSubscriptionTransition({ status: "canceled" }, { status: "active" })).toBe("reactivated");
    expect(detectSubscriptionTransition({ status: "past_due" }, { status: "active" })).toBe("reactivated");
    expect(detectSubscriptionTransition(null, { status: "active" })).toBe("started");
    expect(detectSubscriptionTransition({ status: "incomplete" }, { status: "trialing" })).toBe("started");
  });
});

describe("subscription events", () => {
  it("rejects client writes of subscription events", () => {
    expect(isAuthoritativeFinancialEvent("subscription.started")).toBe(true);
    expect(isServerAuthoritativeEvent("subscription.renewed")).toBe(true);
    expect(() => parseClientAnalyticsEvents({ eventName: "subscription.started", platform: "web" })).toThrow(HttpError);
    expect(() => parseClientAnalyticsEvents({ eventName: "subscription.cancelled", platform: "windows" })).toThrow(/servers/);
  });
});

describe("MRR", () => {
  it("flags estimated MRR when amounts are missing", () => {
    expect(estimatedMrrCents([]).authoritative).toBeNull();
    expect(estimatedMrrCents([]).estimated).toBe(0);
    expect(estimatedMrrCents([]).allAuthoritative).toBe(false);
    const mrr = estimatedMrrCents([{ user_id: USER_A, status: "active", cancel_at_period_end: false }]);
    expect(mrr.estimated).toBe(499);
    expect(mrr.allAuthoritative).toBe(false);
    expect(mrr.authoritative).toBeNull();
    expect(estimatedArrCents(mrr.estimated)).toBe(5988);
  });

  it("uses Stripe amount fields when present", () => {
    expect(
      monthlyRecurringCents({ amount_cents: 4999, billing_interval: "month", interval_count: 1 }).authoritative,
    ).toBe(true);
    expect(monthlyRecurringCents({ amount_cents: 4788, billing_interval: "year", interval_count: 1 }).cents).toBe(399);
    const mrr = estimatedMrrCents([
      {
        user_id: USER_A,
        status: "active",
        cancel_at_period_end: false,
        amount_cents: 499,
        billing_interval: "month",
        interval_count: 1,
      },
    ]);
    expect(mrr.allAuthoritative).toBe(true);
    expect(mrr.authoritative).toBe(499);
    expect(stripeRecurringPrice({
      items: { data: [{ price: { id: "price_x", unit_amount: 499, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
    })).toEqual({
      priceId: "price_x",
      amountCents: 499,
      currency: "USD",
      interval: "month",
      intervalCount: 1,
    });
  });
});

describe("free to paid cohorts", () => {
  it("uses origin windows and excludes immature rows", () => {
    const origins = [
      { user_id: USER_A, origin_at: "2026-08-01T00:00:00.000Z" },
      { user_id: USER_B, origin_at: "2026-08-01T00:00:00.000Z" },
      { user_id: USER_C, origin_at: "2026-08-28T00:00:00.000Z" },
    ];
    const firstPaid = new Map([
      [USER_A, "2026-08-03T00:00:00.000Z"],
      [USER_B, "2026-08-20T00:00:00.000Z"],
    ]);
    expect(paidWithinDays(origins, firstPaid, 7, "2026-08-31")).toBe(0.5);
    expect(paidWithinDays(origins, firstPaid, 7, "2026-08-30")).toBe(0.5);
    expect(paidWithinDays([{ user_id: USER_C, origin_at: "2026-08-28T00:00:00.000Z" }], firstPaid, 7, "2026-08-30")).toBeNull();
  });

  it("does not invent conversion below the sample floor", () => {
    expect(paidConversionAmong([USER_A], new Set([USER_A])).rate).toBeNull();
    expect(paidConversionAmong(Array.from({ length: 10 }, (_, i) => `u${i}`), new Set(["u0", "u1"])).rate).toBe(0.2);
  });
});

describe("churn", () => {
  it("divides by paid at period start", () => {
    expect(subscriptionChurnRate(1, 10)).toBe(0.1);
    expect(subscriptionChurnRate(1, 0)).toBeNull();
    expect(subscriptionChurnRate(1, null)).toBeNull();
  });
});

describe("storage", () => {
  it("buckets and segments without fabricating deletes", () => {
    const users = [
      { storage_used_bytes: 0 },
      { storage_used_bytes: 500 },
      { storage_used_bytes: 2 * GIB },
      { storage_used_bytes: 12 * GIB },
    ];
    expect(storageBucket(0)).toBe("0 GB");
    expect(storageBucket(500)).toBe("<1 GB");
    expect(storageBucket(2 * GIB)).toBe("1–5 GB");
    expect(storageBucket(12 * GIB)).toBe("10–25 GB");
    const segments = storageSegments(users);
    expect(segments.find((row) => row.key === "0 GB")?.users).toBe(1);
    expect(segments.find((row) => row.key === "1–5 GB")?.shareOfUsers).toBe(0.25);
    expect(segments.reduce((sum, row) => sum + row.users, 0)).toBe(4);
    expect(averageOrNull(users.reduce((sum, row) => sum + row.storage_used_bytes, 0), users.length)).toBe(
      (0 + 500 + 2 * GIB + 12 * GIB) / 4,
    );
  });

  it("sorts top consumers by bytes", () => {
    const ranked = topConsumers([
      { user_id: USER_A, storage_used_bytes: 10, plan_slug: "free", ready_clips: 1, last_active_at: null, paid: false, complimentary: false },
      { user_id: USER_B, storage_used_bytes: 99, plan_slug: "pro", ready_clips: 4, last_active_at: null, paid: true, complimentary: false },
    ], 1);
    expect(ranked[0]?.user_id).toBe(USER_B);
    expect(ranked[0]).not.toHaveProperty("storage_key");
  });
});

describe("cost assumptions", () => {
  it("rejects a negative rate and uses configured rates", () => {
    expect(() => validateCostRate(-1)).toThrow(/non-negative/);
    expect(validateCostRate(0.015)).toBe(0.015);
    expect(monthlyStorageCostCents(10 * GIB, 0.015)).toBe(15);
    expect(monthlyStorageCostCents(GIB, null)).toBeNull();
    expect(
      latestAssumption(
        [
          { provider: "r2", metric: "storage", unit: "gb_month", rate: 0.02, currency: "USD", effective_from: "2026-09-01" },
          { provider: "r2", metric: "storage", unit: "gb_month", rate: 0.015, currency: "USD", effective_from: "2026-08-31" },
        ],
        "r2",
        "storage",
        "2026-08-31",
      )?.rate,
    ).toBe(0.015);
  });

  it("does not treat missing bandwidth as zero usage", () => {
    expect(metricAvailability("bandwidth_cost")).toBe("NOT_INSTRUMENTED");
    expect(metricAvailability("estimated_mrr_cents")).toBe("AVAILABLE_ESTIMATE");
    expect(metricAvailability("estimated_arr_cents")).toBe("AVAILABLE_ESTIMATE");
  });

  it("forecasts only with enough history and handles a zero denominator", () => {
    expect(forecastFromAverage([100], 30)).toBeNull();
    expect(forecastFromAverage([100, 200, 300], 30)).toBe(200 * 30);
    expect(divideOrNull(100, 0)).toBeNull();
    expect(divideOrNull(100, null)).toBeNull();
    expect(divideOrNull(100, 4)).toBe(25);
  });
});

describe("admin APIs", () => {
  it("rejects non-admin revenue and infrastructure reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: USER_A, app_metadata: { role: "user" } }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    const env = testEnv();
    await expect(
      handleAdmin(
        new Request("https://www.replayr.tv/v1/admin/analytics/revenue", { headers: { authorization: "Bearer user" } }),
        env,
        new URL("https://www.replayr.tv/v1/admin/analytics/revenue"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handleAdmin(
        new Request("https://www.replayr.tv/v1/admin/analytics/infrastructure", { headers: { authorization: "Bearer user" } }),
        env,
        new URL("https://www.replayr.tv/v1/admin/analytics/infrastructure"),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps custom dates and comparisons on the existing chrome", () => {
    const url = new URL("https://www.replayr.tv/v1/admin/analytics/revenue?range=custom&from=2026-08-01&to=2026-08-15&compare=1");
    const query = parseAdminAnalyticsQuery(url);
    expect(query.from).toBe("2026-08-01");
    expect(query.to).toBe("2026-08-16");
    expect(query.comparison).toEqual(resolveComparisonPeriod(query.from, query.to));
  });

  it("does not return Stripe secrets or object keys on economy payloads", () => {
    const payload = {
      snapshot: { paid: 0, complimentary: 3, premium: 3 },
      mrr: { estimatedCents: 0, isEstimate: true },
      topConsumers: [{ userId: USER_A, plan: "pro", storageBytes: 1, readyClips: 1, access: "paid" }],
    };
    expect(forbiddenFinanceKeys(payload)).toEqual([]);
  });
});
