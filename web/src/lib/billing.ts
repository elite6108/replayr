import { readApiJson } from "./http";
import { apiUrl } from "./supabase";

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

export function fetchBillingStatus(accessToken: string): Promise<BillingStatus> {
  return billingFetch<BillingStatus>("/v1/billing/status", accessToken);
}

export async function startCheckout(
  accessToken: string,
  interval: "month" | "year",
  urls?: { successUrl?: string; cancelUrl?: string },
): Promise<string> {
  const body = await billingFetch<{ url: string }>("/v1/billing/checkout", accessToken, {
    method: "POST",
    body: JSON.stringify({ interval, ...urls }),
  });
  if (!body.url) throw new Error("Checkout did not return a URL.");
  return body.url;
}

export async function startPortal(accessToken: string, returnUrl?: string): Promise<string> {
  const body = await billingFetch<{ url: string }>("/v1/billing/portal", accessToken, {
    method: "POST",
    body: JSON.stringify({ returnUrl }),
  });
  if (!body.url) throw new Error("Billing portal did not return a URL.");
  return body.url;
}

async function billingFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), { ...init, headers });
  return readApiJson<T>(response, "Billing request failed.");
}
