import type { Env } from "./env";

export async function recordProductEvent(
  env: Env,
  name: string,
  value?: number | null,
  dims: Record<string, unknown> = {},
): Promise<void> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;
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
        p_dims: dims,
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
