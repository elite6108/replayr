/** Canonical product-analytics names. Keep stable after release. */

export const ANALYTICS_ENVIRONMENTS = ["production", "development"] as const;
export type AnalyticsEnvironment = (typeof ANALYTICS_ENVIRONMENTS)[number];

export const ANALYTICS_PLATFORMS = ["windows", "web", "ios", "android", "server"] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

export const SERVER_ANALYTICS_EVENTS = {
  signupCompleted: "auth.signup_completed",
  uploadCompleted: "clip.upload_completed",
  uploadFailed: "clip.upload_failed",
  folderCreated: "folder.created",
  folderClipAdded: "folder.clip_added",
  folderInviteSent: "folder.invite_sent",
  folderInviteAccepted: "folder.invite_accepted",
  folderPublicLinkEnabled: "folder.public_link_enabled",
  clipPlayed: "clip.played",
  installerDownloaded: "app.installer_downloaded",
  clipDownloaded: "clip.downloaded",
  clipPublicDownloaded: "clip.public_downloaded",
  folderPublicDownloaded: "folder.public_downloaded",
  checkoutStarted: "subscription.checkout_started",
  subscriptionStarted: "subscription.started",
  subscriptionRenewed: "subscription.renewed",
  subscriptionCancelled: "subscription.cancelled",
  subscriptionExpired: "subscription.expired",
  subscriptionReactivated: "subscription.reactivated",
} as const;

export const CLIENT_ALLOWED_EVENT_EXAMPLES = [
  "auth.signup_started",
  "auth.login",
  "app.opened",
  "app.download_clicked",
  "app.installed",
  "app.updated",
  "capture.started",
  "capture.stopped",
  "replay.enabled",
  "replay.disabled",
  "clip.saved",
  "clip.save_failed",
  "clip.upload_started",
  "clip.shared",
  "clip.editor_opened",
  "clip.edit_saved",
  "clip.rendered",
  "clip.render_failed",
  "visual.filter_selected",
  "visual.filter_applied",
  "visual.filter_rendered",
  "pricing.viewed",
] as const;

const SERVER_ONLY = new Set<string>(Object.values(SERVER_ANALYTICS_EVENTS));

export function isAuthoritativeFinancialEvent(eventName: string): boolean {
  return /^(subscription|billing|revenue|payment)\./.test(eventName);
}

export function isServerAuthoritativeEvent(eventName: string): boolean {
  return SERVER_ONLY.has(eventName) || isAuthoritativeFinancialEvent(eventName);
}

export function serverIdempotencyKey(eventName: string, id: string): string {
  return `${eventName}:${id}`;
}

export const DOWNLOAD_CLICK_EVENT = "app.download_clicked";

export const DOWNLOAD_EVENTS_AVAILABLE_FROM = "2026-08-31";

export const METRIC_DEFINITIONS = {
  totalUsers: "Non-deleted Replayr accounts in auth.users.",
  newUsers: "Accounts created in the selected range (auth.signup_completed).",
  dau: "Unique users with a qualifying active event that UTC day. Not last_sign_in_at.",
  cloudActivated: "Users whose first cloud clip became ready (clip.upload_completed).",
  cloudUploads: "clip.upload_completed events.",
  uploadFailures: "clip.upload_failed events.",
} as const;
