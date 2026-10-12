/** Canonical product-analytics names. Keep stable after release. */

export const ANALYTICS_ENVIRONMENTS = ["production", "development"] as const;
export type AnalyticsEnvironment = (typeof ANALYTICS_ENVIRONMENTS)[number];

export const ANALYTICS_PLATFORMS = ["windows", "web", "ios", "android", "server"] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

export const SERVER_ANALYTICS_EVENTS = {
  signupCompleted: "auth.signup_completed",
  uploadCompleted: "clip.upload_completed",
  uploadFailed: "clip.upload_failed",
  clipDeleted: "clip.deleted",
  screenshotCreated: "screenshot.created",
  screenshotDeleted: "screenshot.deleted",
  screenshotShared: "screenshot.shared",
  messageSent: "message.sent",
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

export const CLIENT_ANALYTICS_EVENT_PROPERTIES = {
  "auth.signup_started": [],
  "auth.login": ["provider"],
  "app.opened": [],
  "app.download_clicked": ["artifact", "platform", "surface"],
  "app.installed": ["source"],
  "app.updated": ["from_version", "to_version"],
  "screen.viewed": ["screen"],
  "capture.started": ["capture_type"],
  "capture.stopped": ["capture_type", "duration_bucket"],
  "replay.enabled": [],
  "replay.disabled": [],
  "clip.saved": [
    "duration_bucket",
    "instant_replay",
    "webcam_enabled",
    "cloud",
    "cloud_uploaded",
    "save_kind",
    "capture_type",
    "quality_preset",
    "source",
    "filter_id",
  ],
  "clip.local_deleted": ["source"],
  "clip.save_failed": ["failure_category"],
  "clip.upload_started": ["source"],
  "clip.shared": ["channel", "filter_id"],
  "clip.editor_opened": ["editor_mode", "duration_bucket", "webcam_enabled"],
  "clip.edit_saved": ["editor_mode"],
  "clip.rendered": ["render_kind", "folder", "filter_id"],
  "clip.render_failed": ["render_type", "error_category"],
  "screenshot.local_created": ["source", "width_bucket", "height_bucket"],
  "screenshot.local_deleted": ["source"],
  "visual.filter_selected": ["filter_id"],
  "visual.filter_applied": ["filter_id"],
  "visual.filter_rendered": ["filter_id", "source"],
  "pricing.viewed": ["surface"],
} as const satisfies Record<string, readonly string[]>;

export const SERVER_ANALYTICS_EVENT_PROPERTIES: Record<string, readonly string[]> = {
  "clip.upload_completed": ["bytes_bucket"],
  "clip.upload_failed": ["reason"],
  "clip.deleted": ["source"],
  "screenshot.created": ["source", "width_bucket", "height_bucket", "replaced_oldest"],
  "screenshot.deleted": ["source"],
  "screenshot.shared": ["channel"],
  "message.sent": ["has_text", "has_clip", "conversation_type"],
  "folder.invite_sent": ["role"],
  "clip.played": ["visibility"],
  "app.installer_downloaded": ["platform", "artifact"],
  "clip.downloaded": ["authenticated"],
  "clip.public_downloaded": ["authenticated"],
  "folder.public_downloaded": ["authenticated"],
  "subscription.checkout_started": ["interval"],
};

export const CLIENT_ALLOWED_EVENT_EXAMPLES = Object.keys(
  CLIENT_ANALYTICS_EVENT_PROPERTIES,
) as Array<keyof typeof CLIENT_ANALYTICS_EVENT_PROPERTIES>;

export function isClientAllowedAnalyticsEvent(
  value: string,
): value is keyof typeof CLIENT_ANALYTICS_EVENT_PROPERTIES {
  return Object.prototype.hasOwnProperty.call(CLIENT_ANALYTICS_EVENT_PROPERTIES, value);
}

export function clientAnalyticsPropertyKeys(eventName: string): ReadonlySet<string> {
  if (!isClientAllowedAnalyticsEvent(eventName)) return new Set();
  return new Set(CLIENT_ANALYTICS_EVENT_PROPERTIES[eventName]);
}

export function serverAnalyticsPropertyKeys(eventName: string): ReadonlySet<string> {
  return new Set(SERVER_ANALYTICS_EVENT_PROPERTIES[eventName] ?? []);
}

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
