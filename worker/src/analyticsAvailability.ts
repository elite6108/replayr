export const METRIC_AVAILABILITY = [
  "AVAILABLE",
  "PROXY",
  "INCOMPLETE",
  "NOT_INSTRUMENTED",
  "AVAILABLE_ESTIMATE",
] as const;

export type MetricAvailability = (typeof METRIC_AVAILABILITY)[number];

export type MetricCatalogEntry = {
  key: string;
  availability: MetricAvailability;
  notes: string;
  availableFrom?: string | null;
};

export const ANALYTICS_METRIC_CATALOG: MetricCatalogEntry[] = [
  {
    key: "new_users",
    availability: "AVAILABLE",
    notes: "auth.users.created_at in the UTC day. Present accounts only.",
  },
  {
    key: "active_users",
    availability: "INCOMPLETE",
    notes: "True DAU: unique authenticated users with a qualifying event that UTC day. Not last_sign_in_at. Desktop app.opened/clip.saved began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "dau",
    availability: "INCOMPLETE",
    notes: "Unique authenticated users with a qualifying active event that UTC day. Not last_sign_in_at.",
    availableFrom: "2026-08-31",
  },
  {
    key: "wau",
    availability: "INCOMPLETE",
    notes: "Unique authenticated users in a 7-day window. Not the sum of seven DAUs.",
    availableFrom: "2026-09-06",
  },
  {
    key: "mau",
    availability: "INCOMPLETE",
    notes: "Unique authenticated users in a 30-day window. Not the sum of DAUs.",
    availableFrom: "2026-09-29",
  },
  {
    key: "dau_mau",
    availability: "INCOMPLETE",
    notes: "DAU / MAU stickiness. Hidden until both windows are mature.",
    availableFrom: "2026-09-29",
  },
  {
    key: "activated_users",
    availability: "INCOMPLETE",
    notes: "First clip.saved or clip.upload_completed. Historical cloud-only activations are cloud_proxy.",
    availableFrom: "2026-08-31",
  },
  {
    key: "activation_rate_7d",
    availability: "INCOMPLETE",
    notes: "Share of a signup cohort that activated within 7 days.",
    availableFrom: "2026-09-07",
  },
  {
    key: "retention_d1",
    availability: "INCOMPLETE",
    notes: "Exact calendar day 1 after signup or activation. Null until mature.",
    availableFrom: "2026-09-01",
  },
  {
    key: "retention_d7",
    availability: "INCOMPLETE",
    notes: "Exact calendar day 7 after signup or activation. Null until mature.",
    availableFrom: "2026-09-07",
  },
  {
    key: "retention_d30",
    availability: "INCOMPLETE",
    notes: "Exact calendar day 30 after signup or activation. Null until mature.",
    availableFrom: "2026-09-30",
  },
  {
    key: "attribution_coverage",
    availability: "AVAILABLE",
    notes: "Share of new users with a known first-touch source. Unknown is not Direct.",
    availableFrom: "2026-08-31",
  },
  {
    key: "cloud_activated_users",
    availability: "PROXY",
    notes: "First ready cloud clip only.",
  },
  {
    key: "app_download_clicks",
    availability: "AVAILABLE",
    notes: "app.download_clicked. Click only. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "installer_downloads",
    availability: "AVAILABLE",
    notes: "GET 200 full-file installer responses. Not a click. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "clip_downloads_authenticated",
    availability: "AVAILABLE",
    notes: "clip.downloaded after a successful signed-in file response. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "clip_downloads_public",
    availability: "AVAILABLE",
    notes: "clip.public_downloaded after a successful anonymous file response. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "folder_public_downloads",
    availability: "AVAILABLE",
    notes: "folder.public_downloaded after a public folder download URL is issued. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "media_downloads_total",
    availability: "AVAILABLE",
    notes: "Authenticated + public clip + public folder downloads. Never includes installers.",
    availableFrom: "2026-08-31",
  },
  {
    key: "cloud_upload_completed",
    availability: "AVAILABLE",
    notes: "Terminal completed upload sessions / ready clips.",
  },
  {
    key: "cloud_upload_failed",
    availability: "AVAILABLE",
    notes: "Clip marked failed. Retryable multipart 502 is not a failure.",
  },
  {
    key: "upload_success_rate",
    availability: "AVAILABLE",
    notes: "completed / (completed + failed). Terminal outcomes only.",
  },
  {
    key: "public_clip_views",
    availability: "AVAILABLE",
    notes: "clip_daily_views for that UTC day.",
  },
  {
    key: "clips_saved",
    availability: "AVAILABLE",
    notes: "Local clip.saved after a successful desktop save. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "total_storage_bytes_end_of_day",
    availability: "AVAILABLE",
    notes: "Current UTC day snapshot of user_storage. Original cloud media quota only.",
  },
  {
    key: "storage_bytes_added",
    availability: "AVAILABLE",
    notes: "Ready clip file_size_bytes that day. Original MP4 only.",
  },
  {
    key: "storage_bytes_deleted",
    availability: "INCOMPLETE",
    notes: "Soft-deletes by updated_at when present. Not a full deletion ledger.",
  },
  {
    key: "net_storage_change_bytes",
    availability: "INCOMPLETE",
    notes: "Left null. Do not treat added minus deleted as a reconciled ledger.",
  },
  {
    key: "estimated_mrr_cents",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Estimate only. Uses Stripe amount_cents when present, else $4.99 / $3.99. mrr_is_estimate is always true. Not Revenue.",
  },
  {
    key: "top_games",
    availability: "AVAILABLE",
    notes: "Ready cloud clips by games.slug. Unknown is a missing game_id, not an exe name.",
  },
  {
    key: "game_community_retention_d7",
    availability: "INCOMPLETE",
    notes: "Exact-day D7 after the user's first ready cloud clip of that game.",
    availableFrom: "2026-08-31",
  },
  {
    key: "top_filters",
    availability: "INCOMPLETE",
    notes: "visual.filter_* and clip.saved/rendered filter_id. none is stored but not a used filter.",
    availableFrom: "2026-08-31",
  },
  {
    key: "feature_adoption",
    availability: "INCOMPLETE",
    notes: "Unique feature users / active users. Capture and replay are adoption-only, not DAU.",
    availableFrom: "2026-08-31",
  },
  {
    key: "folder_adoption",
    availability: "AVAILABLE",
    notes: "Folder creates, clip adds, invites, and public links from folder tables.",
  },
  {
    key: "folder_user_engagement",
    availability: "INCOMPLETE",
    notes: "Active-day rate of folder owners/members vs everyone else.",
    availableFrom: "2026-08-31",
  },
  {
    key: "clips_shared",
    availability: "INCOMPLETE",
    notes: "clip.shared after a successful send or copy-link. Tracking began 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "share_to_download",
    availability: "NOT_INSTRUMENTED",
    notes: "Shared clips are not identity-stitched to installer downloads.",
  },
  {
    key: "clips_per_active_user",
    availability: "INCOMPLETE",
    notes: "clip.saved / DAU. Null until both exist.",
    availableFrom: "2026-08-31",
  },
  {
    key: "power_users",
    availability: "PROXY",
    notes: "Top decile of ready cloud clips in the selected range.",
  },
  {
    key: "paid_subscribers",
    availability: "AVAILABLE",
    notes: "billing_subscriptions status active or trialing. Grants and past_due are excluded.",
  },
  {
    key: "complimentary_premium",
    availability: "AVAILABLE",
    notes: "Active billing_grants. Not paid subscribers.",
  },
  {
    key: "scheduled_cancellations",
    availability: "AVAILABLE",
    notes: "Paid subscriptions with cancel_at_period_end. Still paid until access ends.",
  },
  {
    key: "new_paid_subscribers",
    availability: "INCOMPLETE",
    notes: "subscription.started or stripe customer.subscription.created.",
    availableFrom: "2026-08-31",
  },
  {
    key: "cancelled_subscriptions",
    availability: "INCOMPLETE",
    notes: "subscription.cancelled or stripe deleted. cancel_at_period_end is not churn.",
    availableFrom: "2026-08-31",
  },
  {
    key: "subscription_churn_rate",
    availability: "INCOMPLETE",
    notes: "Cancelled+expired / paid at period start. Null without a start snapshot.",
  },
  {
    key: "estimated_arr_cents",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Estimated MRR × 12. Not Revenue.",
  },
  {
    key: "free_to_paid_7d",
    availability: "INCOMPLETE",
    notes: "Signup cohort that paid within 7 days.",
    availableFrom: "2026-09-07",
  },
  {
    key: "arpu",
    availability: "INCOMPLETE",
    notes: "Estimated MRR / MAU when mature, else DAU.",
    availableFrom: "2026-08-31",
  },
  {
    key: "arppu",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Estimated MRR / paid subscribers.",
  },
  {
    key: "infra_cost_monthly_cents",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Storage bytes × configured R2 gb_month rate. Bandwidth is not measured.",
  },
  {
    key: "infra_cost_per_active_user",
    availability: "INCOMPLETE",
    notes: "Estimated monthly storage cost / active users.",
    availableFrom: "2026-08-31",
  },
  {
    key: "infra_cost_per_paid_user",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Estimated monthly storage cost / paid subscribers.",
  },
  {
    key: "ready_cloud_clips",
    availability: "AVAILABLE",
    notes: "Ready original cloud clips. Not derivatives.",
  },
  {
    key: "average_clip_bytes",
    availability: "AVAILABLE",
    notes: "Total original cloud bytes / ready clips.",
  },
  {
    key: "storage_per_cloud_user",
    availability: "AVAILABLE",
    notes: "Original cloud quota / users with storage or ready clips.",
  },
  {
    key: "storage_per_paid_user",
    availability: "AVAILABLE",
    notes: "Original cloud quota / paid subscribers. Null if no paid users.",
  },
  {
    key: "bandwidth_cost",
    availability: "NOT_INSTRUMENTED",
    notes: "No R2 or Bunny bandwidth feed. Do not show as 0 usage.",
  },
  {
    key: "clip_save_success_rate",
    availability: "INCOMPLETE",
    notes: "clip.saved / (saved + save_failed excluding cancelled). Desktop from 2026-08-31.",
    availableFrom: "2026-08-31",
  },
  {
    key: "render_success_rate",
    availability: "INCOMPLETE",
    notes: "clip.rendered / (rendered + render_failed). Cancellations omitted.",
    availableFrom: "2026-08-31",
  },
  {
    key: "error_events",
    availability: "AVAILABLE",
    notes: "error_events groups last seen that UTC day.",
  },
  {
    key: "critical_errors",
    availability: "AVAILABLE",
    notes: "error_events.level = crash.",
  },
  {
    key: "unique_affected_users",
    availability: "AVAILABLE",
    notes: "Distinct sample_user_id on error groups last seen that day.",
  },
  {
    key: "health_version_comparison",
    availability: "INCOMPLETE",
    notes: "Requires app_version. Sample >= 100 to flag a regression.",
    availableFrom: "2026-08-31",
  },
  {
    key: "storage_forecast",
    availability: "AVAILABLE_ESTIMATE",
    notes: "Average daily storage added × 30/90. Gross-growth because deletes are incomplete.",
  },
];

export function metricAvailability(key: string): MetricAvailability {
  return ANALYTICS_METRIC_CATALOG.find((item) => item.key === key)?.availability ?? "NOT_INSTRUMENTED";
}

export function isDisplayableMetric(key: string): boolean {
  const availability = metricAvailability(key);
  return availability === "AVAILABLE" || availability === "PROXY" || availability === "AVAILABLE_ESTIMATE";
}

/** Terminal clip/session outcomes. Failed clips already include expired/aborted. */
export function uploadSuccessRate(completed: number, failed: number, expiredAborted = 0): number | null {
  void expiredAborted;
  const denominator = completed + failed;
  if (denominator <= 0) return null;
  return completed / denominator;
}
