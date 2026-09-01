import type { Env } from "./env";
import { requireServiceRole } from "./shared";

export const AUDIT_ACTIONS = {
  adminConfigChanged: "admin.config_changed",
  adminSubscriptionGranted: "admin.subscription_granted",
  adminSubscriptionRevoked: "admin.subscription_revoked",
  billingPlanChangedByAdmin: "billing.plan_changed_by_admin",
  moderationClipRemoved: "moderation.clip_removed",
  folderOwnershipTransferred: "folder.ownership_transferred",
  folderMemberRemoved: "folder.member_removed",
  folderMemberRoleChanged: "folder.member_role_changed",
  folderPublicLinkEnabled: "folder.public_link_enabled",
  folderPublicLinkDisabled: "folder.public_link_disabled",
  folderPublicLinkRegenerated: "folder.public_link_regenerated",
  analyticsReportGenerated: "analytics.report_generated",
  analyticsReportRegenerated: "analytics.report_regenerated",
  analyticsReportDeleted: "analytics.report_deleted",
} as const;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "admin.config_changed": "Admin config changed",
  "admin.subscription_granted": "Complimentary subscription granted",
  "admin.subscription_revoked": "Complimentary subscription revoked",
  "billing.plan_changed_by_admin": "Plan changed by admin",
  "moderation.clip_removed": "Clip removed",
  "folder.ownership_transferred": "Folder ownership transferred",
  "folder.member_removed": "Folder member removed",
  "folder.member_role_changed": "Folder member role changed",
  "folder.public_link_enabled": "Folder public link enabled",
  "folder.public_link_disabled": "Folder public link disabled",
  "folder.public_link_regenerated": "Folder public link regenerated",
  "analytics.report_generated": "Analytics report generated",
  "analytics.report_regenerated": "Analytics report regenerated",
  "analytics.report_deleted": "Analytics report deleted",
};

const BLOCKED_META = /secret|token|cookie|jwt|password|authorization|storage_key|object_key|thumbnail_key|public_token|webhook|sk_live/i;

export type AuditActorType = "user" | "admin" | "system";

export type AuditWrite = {
  actorUserId?: string | null;
  actorType: AuditActorType;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
  environment?: string | null;
};

export function sanitizeAuditMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (BLOCKED_META.test(key)) continue;
    if (item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      if (typeof item === "string" && (BLOCKED_META.test(item) || item.length > 200)) continue;
      next[key] = item;
    }
  }
  return next;
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

export function requestCorrelationId(request?: Request | null): string | null {
  const ray = request?.headers.get("cf-ray") || request?.headers.get("x-request-id");
  return ray?.slice(0, 80) || null;
}

export async function writeAuditLog(env: Env, input: AuditWrite): Promise<void> {
  try {
    const key = requireServiceRole(env);
    await fetch(`${env.SUPABASE_URL}/rest/v1/audit_log`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        actor_user_id: input.actorUserId ?? null,
        actor_type: input.actorType,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        metadata: sanitizeAuditMetadata(input.metadata),
        request_id: input.requestId ?? null,
        environment: input.environment ?? "production",
      }),
    });
  } catch {
    /* observational — do not fail the mutation */
  }
}
