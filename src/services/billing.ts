import { publicApiUrl } from "../branding";

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

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let body: { error?: string } = {};
  try {
    body = text ? (JSON.parse(text) as { error?: string }) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || fallback);
  return body as T;
}

export async function fetchBillingStatus(accessToken: string): Promise<BillingStatus> {
  const response = await fetch(`${publicApiUrl()}/v1/billing/status`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  return readJson<BillingStatus>(response, "Could not load billing status.");
}

export async function startCheckout(
  accessToken: string,
  interval: "month" | "year",
  urls?: { successUrl?: string; cancelUrl?: string },
): Promise<string> {
  const response = await fetch(`${publicApiUrl()}/v1/billing/checkout`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ interval, ...urls }),
  });
  const body = await readJson<{ url?: string }>(response, "Could not start checkout.");
  if (!body.url) throw new Error("Checkout did not return a URL.");
  return body.url;
}

export async function startPortal(accessToken: string, returnUrl?: string): Promise<string> {
  const response = await fetch(`${publicApiUrl()}/v1/billing/portal`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ returnUrl }),
  });
  const body = await readJson<{ url?: string }>(response, "Could not open billing portal.");
  if (!body.url) throw new Error("Billing portal did not return a URL.");
  return body.url;
}
