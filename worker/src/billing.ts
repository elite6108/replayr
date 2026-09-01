import { observeServerAnalytics, SERVER_ANALYTICS_EVENTS } from "./analytics";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireServiceRole, requireUser, serviceRest, type AuthUser } from "./shared";
import { detectSubscriptionTransition } from "./analyticsRevenue";

const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PlanRow {
  slug: string;
  storage_limit_bytes: number;
  max_clip_duration_ms: number | null;
  max_upload_quality: string | null;
  watermark: boolean;
  ads: boolean;
}

interface SettingsRow {
  watermark_enabled: boolean;
  ads_enabled: boolean;
}

interface CustomerRow {
  user_id: string;
  stripe_customer_id: string;
}

interface SubscriptionRow {
  user_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

interface GrantRow {
  plan_slug: string;
  expires_at: string | null;
}

interface StorageJoin {
  storage_used_bytes: number;
  storage_limit_bytes: number;
  plans: PlanRow | PlanRow[] | null;
}

export interface BillingStatus {
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  complimentary: boolean;
  watermark: boolean;
  ads: boolean;
  storageUsedBytes: number;
  storageLimitBytes: number;
  maxClipDurationMs: number | null;
  maxUploadQuality: string | null;
  premium: boolean;
}

export async function handleBilling(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
    return webhook(request, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/billing/status") {
    return json(await billingStatus(env, await requireUser(request, env)));
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    return checkout(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/portal") {
    return portal(request, env);
  }
  return null;
}

export async function billingStatus(env: Env, user: AuthUser): Promise<BillingStatus> {
  return loadStatus(env, user.id);
}

export async function loadStatus(env: Env, userId: string): Promise<BillingStatus> {
  const [storageRows, subRows, grantRows, settingsRows] = await Promise.all([
    serviceRest<StorageJoin[]>(
      env,
      "GET",
      `/user_storage?user_id=eq.${userId}&select=storage_used_bytes,storage_limit_bytes,plans(slug,storage_limit_bytes,max_clip_duration_ms,max_upload_quality,watermark,ads)`,
    ),
    serviceRest<SubscriptionRow[]>(
      env,
      "GET",
      `/billing_subscriptions?user_id=eq.${userId}&select=user_id,stripe_subscription_id,stripe_price_id,status,current_period_end,cancel_at_period_end`,
    ),
    serviceRest<GrantRow[]>(
      env,
      "GET",
      `/billing_grants?user_id=eq.${userId}&revoked_at=is.null&or=(expires_at.is.null,expires_at.gt.${new Date().toISOString()})&select=plan_slug,expires_at&order=created_at.desc&limit=1`,
    ),
    serviceRest<SettingsRow[]>(env, "GET", "/app_settings?id=eq.1&select=watermark_enabled,ads_enabled"),
  ]);
  const storage = storageRows[0];
  const plan = firstPlan(storage?.plans) ?? fallbackFree();
  const sub = subRows[0];
  const grant = grantRows[0];
  const settings = settingsRows[0] ?? { watermark_enabled: true, ads_enabled: true };
  const complimentary = Boolean(grant);
  const premium = complimentary || plan.slug === "pro" || plan.slug === "pro_plus";
  return {
    plan: plan.slug,
    status: sub?.status ?? (complimentary ? "complimentary" : "none"),
    currentPeriodEnd: sub?.current_period_end ?? grant?.expires_at ?? null,
    cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
    complimentary,
    watermark: Boolean(settings.watermark_enabled && plan.watermark && !premium),
    ads: Boolean(settings.ads_enabled && plan.ads && !premium),
    storageUsedBytes: Number(storage?.storage_used_bytes ?? 0),
    storageLimitBytes: Number(storage?.storage_limit_bytes ?? plan.storage_limit_bytes),
    maxClipDurationMs: plan.max_clip_duration_ms,
    maxUploadQuality: plan.max_upload_quality,
    premium,
  };
}

export async function assertUploadAllowed(
  env: Env,
  userId: string,
  body: { durationMs?: number | null; width?: number | null; height?: number | null; fps?: number | null },
): Promise<BillingStatus> {
  const status = await loadStatus(env, userId);
  if (status.maxClipDurationMs != null && body.durationMs != null && body.durationMs > status.maxClipDurationMs) {
    throw new HttpError(
      403,
      `Free cloud clips are limited to ${Math.round(status.maxClipDurationMs / 60000)} minutes. Upgrade to Premium to upload longer clips.`,
    );
  }
  if (status.maxUploadQuality === "1080p") {
    const width = Number(body.width ?? 0);
    const height = Number(body.height ?? 0);
    // 1080p includes landscape 1920×1080 and portrait/shorts 1080×1920.
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    if (longSide > 1920 || shortSide > 1080) {
      throw new HttpError(403, "Free cloud uploads are limited to 1080p. Upgrade to Premium for original quality.");
    }
  }
  return status;
}

async function checkout(request: Request, env: Env): Promise<Response> {
  requireStripe(env);
  const user = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as {
    interval?: string;
    successUrl?: string;
    cancelUrl?: string;
  };
  const yearly = body.interval === "year";
  const price = yearly ? env.STRIPE_PRICE_PREMIUM_YEARLY : env.STRIPE_PRICE_PREMIUM_MONTHLY;
  if (!price) throw new HttpError(503, "Replayr Premium prices are not configured.");

  const origin = publicOrigin(env, request);
  const successUrl =
    sanitizeReturnUrl(body.successUrl, origin) ?? `${origin}/account?billing=success`;
  const cancelUrl = sanitizeReturnUrl(body.cancelUrl, origin) ?? `${origin}/pricing`;
  const customerId = await ensureCustomer(env, user);
  const session = await stripeForm<{ url?: string }>(env, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[user_id]": user.id,
    "subscription_data[metadata][user_id]": user.id,
    "subscription_data[trial_period_days]": "7",
    allow_promotion_codes: "true",
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL.");
  observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.checkoutStarted, {
    userId: user.id,
    entityId: user.id,
    idempotencyKey: `subscription.checkout_started:${user.id}:${new Date().toISOString().slice(0, 10)}:${yearly ? "year" : "month"}`,
    properties: { interval: yearly ? "year" : "month" },
  });
  return json({ url: session.url });
}

async function portal(request: Request, env: Env): Promise<Response> {
  requireStripe(env);
  const user = await requireUser(request, env);
  const body = (await request.json().catch(() => ({}))) as { returnUrl?: string };
  const origin = publicOrigin(env, request);
  const customers = await serviceRest<CustomerRow[]>(
    env,
    "GET",
    `/billing_customers?user_id=eq.${user.id}&select=user_id,stripe_customer_id`,
  );
  const customerId = customers[0]?.stripe_customer_id;
  if (!customerId) throw new HttpError(400, "No Stripe customer is attached to this account yet.");
  const session = await stripeForm<{ url?: string }>(env, "POST", "/v1/billing_portal/sessions", {
    customer: customerId,
    return_url: sanitizeReturnUrl(body.returnUrl, origin) ?? `${origin}/account`,
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a billing portal URL.");
  return json({ url: session.url });
}

async function webhook(request: Request, env: Env): Promise<Response> {
  requireStripe(env);
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Stripe webhook secret is not configured.");
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") || "";
  if (!(await verifyStripeSignature(raw, signature, env.STRIPE_WEBHOOK_SECRET))) {
    throw new HttpError(400, "Stripe signature is invalid.");
  }
  const event = JSON.parse(raw) as {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  if (!event.id || !event.type) throw new HttpError(400, "Stripe event is incomplete.");

  const existing = await serviceRest<{ id: string; ok: boolean }[]>(
    env,
    "GET",
    `/stripe_events?id=eq.${encodeURIComponent(event.id)}&select=id,ok`,
  );
  if (existing[0]?.ok) return json({ ok: true, duplicate: true });

  let userId: string | null = null;
  let error: string | null = null;
  try {
    userId = await applyStripeEvent(env, event.type, event.data?.object ?? {});
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Webhook failed.";
  }
  if (existing[0]) {
    await serviceRest(env, "PATCH", `/stripe_events?id=eq.${encodeURIComponent(event.id)}`, {
      user_id: userId,
      ok: !error,
      error,
    });
  } else {
    await serviceRest(env, "POST", "/stripe_events", {
      id: event.id,
      type: event.type,
      user_id: userId,
      ok: !error,
      error,
    });
  }
  if (error) throw new HttpError(500, error);
  return json({ ok: true });
}

async function applyStripeEvent(env: Env, type: string, object: Record<string, unknown>): Promise<string | null> {
  if (type === "checkout.session.completed") {
    const userId = stringField(object.client_reference_id) || metadataUser(object);
    const customerId = stringField(object.customer);
    if (userId && customerId) await upsertCustomer(env, userId, customerId);
    const subscriptionId = stringField(object.subscription);
    if (subscriptionId) await syncSubscription(env, subscriptionId, userId);
    return userId;
  }
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    return syncSubscriptionObject(env, object);
  }
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const subscriptionId = invoiceSubscriptionId(object);
    if (!subscriptionId) return metadataUser(object);
    const invoiceId = type === "invoice.paid" ? stringField(object.id) : null;
    return syncSubscription(env, subscriptionId, metadataUser(object), invoiceId);
  }
  return metadataUser(object);
}

async function syncSubscription(
  env: Env,
  subscriptionId: string,
  knownUserId: string | null,
  invoicePaidId?: string | null,
): Promise<string | null> {
  const subscription = await stripeGet<Record<string, unknown>>(env, `/v1/subscriptions/${subscriptionId}`);
  return syncSubscriptionObject(env, subscription, knownUserId, invoicePaidId);
}

async function syncSubscriptionObject(
  env: Env,
  object: Record<string, unknown>,
  knownUserId?: string | null,
  invoicePaidId?: string | null,
): Promise<string | null> {
  const subscriptionId = stringField(object.id);
  const customerId = stringField(object.customer);
  const status = stringField(object.status) || "incomplete";
  const priceId = subscriptionPriceId(object);
  const periodEnd = periodEndIso(object);
  const cancelAtPeriodEnd = Boolean(object.cancel_at_period_end);
  const price = stripeRecurringPrice(object);
  const createdAt = unixToIso(object.created);
  let userId = knownUserId || metadataUser(object);
  if (!userId && customerId) {
    const rows = await serviceRest<CustomerRow[]>(
      env,
      "GET",
      `/billing_customers?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id,stripe_customer_id`,
    );
    userId = rows[0]?.user_id ?? null;
  }
  if (!userId || !subscriptionId) return userId;

  if (customerId) await upsertCustomer(env, userId, customerId);
  const previous = await serviceRest<SubscriptionRow[]>(
    env,
    "GET",
    `/billing_subscriptions?user_id=eq.${userId}&select=user_id,stripe_subscription_id,stripe_price_id,status,current_period_end,cancel_at_period_end`,
  );
  const payload: Record<string, unknown> = {
    user_id: userId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: priceId,
    status,
    current_period_end: periodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    updated_at: new Date().toISOString(),
  };
  if (price.amountCents != null) payload.amount_cents = price.amountCents;
  if (price.currency) payload.currency = price.currency;
  if (price.interval) payload.billing_interval = price.interval;
  if (price.intervalCount != null) payload.interval_count = price.intervalCount;
  if (createdAt) payload.created_at = createdAt;
  await serviceRest(
    env,
    "POST",
    "/billing_subscriptions?on_conflict=user_id",
    payload,
    "resolution=merge-duplicates,return=representation",
  );
  const transition = detectSubscriptionTransition(previous[0] ?? null, { status });
  if (transition === "started") {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.subscriptionStarted, {
      userId,
      entityId: subscriptionId,
    });
  } else if (transition === "cancelled") {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.subscriptionCancelled, {
      userId,
      entityId: subscriptionId,
    });
  } else if (transition === "expired") {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.subscriptionExpired, {
      userId,
      entityId: subscriptionId,
    });
  } else if (transition === "reactivated") {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.subscriptionReactivated, {
      userId,
      entityId: subscriptionId,
      idempotencyKey: `subscription.reactivated:${subscriptionId}:${new Date().toISOString().slice(0, 10)}`,
    });
  } else if (invoicePaidId && previous[0] && isPaidBillingStatus(previous[0].status) && isPaidBillingStatus(status)) {
    observeServerAnalytics(env, SERVER_ANALYTICS_EVENTS.subscriptionRenewed, {
      userId,
      entityId: subscriptionId,
      idempotencyKey: `subscription.renewed:${subscriptionId}:${invoicePaidId}`,
    });
  }

  const slug = PAID_STATUSES.has(status) ? "pro" : "free";
  await serviceRest(env, "POST", "/rpc/apply_user_plan", {
    p_user_id: userId,
    p_slug: slug,
    p_force: false,
  });
  return userId;
}

export async function applyPlan(env: Env, userId: string, slug: string, force = false): Promise<void> {
  await serviceRest(env, "POST", "/rpc/apply_user_plan", {
    p_user_id: userId,
    p_slug: slug,
    p_force: force,
  });
}

export async function upsertCustomer(env: Env, userId: string, stripeCustomerId: string): Promise<void> {
  await serviceRest(
    env,
    "POST",
    "/billing_customers?on_conflict=user_id",
    {
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      updated_at: new Date().toISOString(),
    },
    "resolution=merge-duplicates,return=representation",
  );
}

async function ensureCustomer(env: Env, user: AuthUser): Promise<string> {
  const rows = await serviceRest<CustomerRow[]>(
    env,
    "GET",
    `/billing_customers?user_id=eq.${user.id}&select=user_id,stripe_customer_id`,
  );
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;
  const email = await userEmail(env, user);
  const created = await stripeForm<{ id?: string }>(env, "POST", "/v1/customers", {
    ...(email ? { email } : {}),
    "metadata[user_id]": user.id,
  });
  if (!created.id) throw new HttpError(502, "Stripe did not create a customer.");
  await upsertCustomer(env, user.id, created.id);
  return created.id;
}

async function userEmail(env: Env, user: AuthUser): Promise<string | null> {
  const key = requireServiceRole(env);
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { email?: string };
  return body.email || null;
}

export async function stripeForm<T>(
  env: Env,
  method: string,
  path: string,
  fields: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${requireStripe(env)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" || method === "DELETE" ? undefined : new URLSearchParams(fields),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : 400, stripeError(text) || "Stripe request failed.");
  }
  return JSON.parse(text) as T;
}

export async function stripeGet<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { authorization: `Bearer ${requireStripe(env)}` },
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(502, stripeError(text) || "Stripe request failed.");
  return JSON.parse(text) as T;
}

function requireStripe(env: Env): string {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "Stripe is not configured on the Worker.");
  return env.STRIPE_SECRET_KEY;
}

function publicOrigin(env: Env, request: Request): string {
  try {
    return new URL(env.PUBLIC_APP_URL || request.url).origin;
  } catch {
    return "https://www.replayr.tv";
  }
}

function sanitizeReturnUrl(value: string | undefined, origin: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "replayr:") return value;
    if (url.origin === origin) return value;
    if (url.hostname === "replayr.tv" || url.hostname === "www.replayr.tv") return value;
    return null;
  } catch {
    return null;
  }
}

function firstPlan(value: PlanRow | PlanRow[] | null | undefined): PlanRow | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function fallbackFree(): PlanRow {
  return {
    slug: "free",
    storage_limit_bytes: 5368709120,
    max_clip_duration_ms: 1200000,
    max_upload_quality: "1080p",
    watermark: true,
    ads: true,
  };
}

function metadataUser(object: Record<string, unknown>): string | null {
  const meta = object.metadata;
  if (!meta || typeof meta !== "object") return null;
  const id = stringField((meta as { user_id?: unknown }).user_id);
  return id && UUID.test(id) ? id : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function subscriptionPriceId(object: Record<string, unknown>): string | null {
  return stripeRecurringPrice(object).priceId;
}

export function stripeRecurringPrice(object: Record<string, unknown>): {
  priceId: string | null;
  amountCents: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount: number | null;
} {
  const items = object.items as {
    data?: {
      price?: {
        id?: string;
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string; interval_count?: number };
      };
    }[];
  } | undefined;
  const price = items?.data?.[0]?.price;
  const amount = Number(price?.unit_amount);
  const count = Number(price?.recurring?.interval_count);
  return {
    priceId: price?.id ?? null,
    amountCents: Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null,
    currency: typeof price?.currency === "string" && price.currency ? price.currency.toUpperCase() : null,
    interval: typeof price?.recurring?.interval === "string" ? price.recurring.interval : null,
    intervalCount: Number.isFinite(count) && count > 0 ? count : null,
  };
}

function unixToIso(value: unknown): string | null {
  const unix = Number(value);
  if (!Number.isFinite(unix) || unix <= 0) return null;
  return new Date(unix * 1000).toISOString();
}

function isPaidBillingStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

function invoiceSubscriptionId(object: Record<string, unknown>): string | null {
  const parent = object.parent as { subscription_details?: { subscription?: string } } | undefined;
  return stringField(object.subscription) || stringField(parent?.subscription_details?.subscription) || null;
}

function periodEndIso(object: Record<string, unknown>): string | null {
  const items = object.items as { data?: { current_period_end?: number }[] } | undefined;
  const unix = Number(object.current_period_end ?? items?.data?.[0]?.current_period_end ?? 0);
  if (!Number.isFinite(unix) || unix <= 0) return null;
  return new Date(unix * 1000).toISOString();
}

function stripeError(body: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: string } };
    return value.error?.message || body;
  } catch {
    return body;
  }
}

export async function verifyStripeSignature(raw: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((item) => {
      const index = item.indexOf("=");
      return index === -1 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)];
    }),
  );
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`));
  const hex = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < hex.length; i += 1) mismatch |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
