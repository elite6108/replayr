import type { Env } from "./env";

export async function recordProductEvent(
  env: Env,
  name: string,
  value?: number | null,
  dims: Record<string, unknown> = {},
): Promise<void> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;
  const safeDims: Record<string, string | number | boolean> = {};
  for (const [dimension, item] of Object.entries(dims)) {
    if (!["action", "route"].includes(dimension)) continue;
    if (typeof item === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(item)) safeDims[dimension] = item;
    else if (typeof item === "number" && Number.isFinite(item)) safeDims[dimension] = item;
    else if (typeof item === "boolean") safeDims[dimension] = item;
  }
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ingest_product_event`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_name: name,
        p_value: value ?? null,
        p_dims: safeDims,
      }),
    });
    if (!response.ok) {
      /* best-effort telemetry */
      await response.text().catch(() => "");
    }
  } catch {
    /* never fail the user request because telemetry failed */
  }
}
