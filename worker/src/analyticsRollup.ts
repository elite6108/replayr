import { ANALYTICS_METRIC_CATALOG } from "./analyticsAvailability";
import { assertBackfillRange, recentRollupRange, type UtcDay } from "./analyticsDates";
import type { Env } from "./env";
import { HttpError } from "./http";
import { requireServiceRole } from "./shared";

export async function runRecentAnalyticsRollup(env: Env, now = new Date()): Promise<{ from: UtcDay; to: UtcDay; days: number }> {
  const range = recentRollupRange(now);
  const days = await rollupAnalyticsDays(env, range.from, range.to);
  return { ...range, days };
}

export async function rebuildAnalyticsDaily(
  env: Env,
  fromInclusive: string,
  toExclusive: string,
): Promise<{ from: UtcDay; to: UtcDay; days: number }> {
  const range = assertBackfillRange(fromInclusive, toExclusive);
  const days = await rollupAnalyticsDays(env, range.from, range.to);
  return { ...range, days };
}

export async function rollupAnalyticsDays(env: Env, from: UtcDay, to: UtcDay): Promise<number> {
  const key = requireServiceRole(env);
  const days = await callRollup(env, key, "rollup_analytics_days", from, to);
  await callRollup(env, key, "rollup_analytics_growth_days", from, to).catch(() => 0);
  await callRollup(env, key, "rollup_analytics_product_days", from, to).catch(() => 0);
  await callRollup(env, key, "rollup_analytics_revenue_days", from, to).catch(() => 0);
  await callRollup(env, key, "rollup_analytics_health_days", from, to).catch(() => 0);
  return days;
}

async function callRollup(env: Env, key: string, fn: string, from: UtcDay, to: UtcDay): Promise<number> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_from: from, p_to: to }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(502, text || "Could not roll up analytics.");
  }
  const body = (await response.json().catch(() => 0)) as number | { rollup_analytics_days?: number };
  return typeof body === "number" ? body : Number(body.rollup_analytics_days ?? 0);
}

export function metricCatalog() {
  return ANALYTICS_METRIC_CATALOG;
}
