import { readApiJson } from "./http";
import { apiUrl } from "./supabase";
import type {
  BlockedAccount,
  BlockedAccountsResponse,
  ContentReportResult,
  ReportReason,
  ReportTargetType,
} from "./social-types";

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  hate: "Hate",
  sexual: "Sexual content",
  violence: "Violence",
  self_harm: "Self-harm",
  impersonation: "Impersonation",
  other: "Something else",
};

function authHeaders(accessToken: string, json = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

export async function reportContent(
  accessToken: string,
  body: { targetType: ReportTargetType; targetId: string; reason: ReportReason; details?: string },
): Promise<ContentReportResult> {
  const response = await fetch(apiUrl("/v1/reports"), {
    method: "POST",
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      details: body.details?.trim() || undefined,
    }),
  });
  return readApiJson<ContentReportResult>(response, "Could not send that report.");
}

export async function unblockUser(accessToken: string, userId: string): Promise<void> {
  const response = await fetch(apiUrl(`/v1/friends/${encodeURIComponent(userId)}/block`), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  await readApiJson<{ ok?: boolean }>(response, "Could not unblock that account.");
}

export async function fetchBlockedAccounts(accessToken: string): Promise<BlockedAccount[]> {
  const response = await fetch(apiUrl("/v1/blocks"), { headers: authHeaders(accessToken) });
  const body = await readApiJson<BlockedAccountsResponse>(response, "Could not load blocked accounts.");
  return body.users ?? [];
}
