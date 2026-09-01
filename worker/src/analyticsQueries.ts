import { ANALYTICS_METRIC_CATALOG, uploadSuccessRate } from "./analyticsAvailability";
import { halfOpenUtcRange, type UtcDay } from "./analyticsDates";
import type { UserActivityDay, UserMilestone } from "./analyticsGrowth";
import type { Env } from "./env";
import { HttpError } from "./http";
import { serviceRest } from "./shared";

export type AnalyticsQueryOptions = {
  from: string;
  to: string;
  environment?: "production" | "development";
};

function range(options: AnalyticsQueryOptions): { from: UtcDay; to: UtcDay; environment: "production" | "development" } {
  try {
    const { from, to } = halfOpenUtcRange(options.from, options.to);
    return { from, to, environment: options.environment ?? "production" };
  } catch (caught) {
    throw new HttpError(400, caught instanceof Error ? caught.message : "Range must be [from, to) with to after from.");
  }
}

function dayFilter(from: UtcDay, to: UtcDay, environment: string) {
  return `day=gte.${from}&day=lt.${to}&environment=eq.${environment}&order=day.asc`;
}

export async function getOverviewDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  const rows = await serviceRest<Record<string, unknown>[]>(
    env,
    "GET",
    `/analytics_daily?select=*&${dayFilter(from, to, environment)}`,
  );
  return {
    environment,
    from,
    to,
    availability: {
      new_users: "AVAILABLE",
      active_users: "INCOMPLETE",
      activated_users: "INCOMPLETE",
      cloud_activated_users: "PROXY",
    },
    rows,
  };
}

export async function getDownloadDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  const rows = await serviceRest<Record<string, unknown>[]>(
    env,
    "GET",
    `/analytics_downloads_daily?select=*&${dayFilter(from, to, environment)}`,
  );
  return {
    environment,
    from,
    to,
    availability: {
      app_download_clicks: "AVAILABLE",
      installer_downloads: "AVAILABLE",
      clip_downloads_authenticated: "AVAILABLE",
      clip_downloads_public: "AVAILABLE",
      folder_public_downloads: "AVAILABLE",
    },
    rows,
  };
}

export async function getClipDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  const rows = await serviceRest<
    Array<{
      cloud_upload_completed: number;
      cloud_upload_failed: number;
      cloud_upload_expired_aborted: number;
      [key: string]: unknown;
    }>
  >(env, "GET", `/analytics_clips_daily?select=*&${dayFilter(from, to, environment)}`);
  return {
    environment,
    from,
    to,
    rows: rows.map((row) => ({
      ...row,
      upload_success_rate: uploadSuccessRate(
        Number(row.cloud_upload_completed || 0),
        Number(row.cloud_upload_failed || 0),
      ),
    })),
  };
}

export async function getStorageDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  return {
    environment,
    from,
    to,
    storageScope: "original_cloud_media_only",
    rows: await serviceRest<Record<string, unknown>[]>(
      env,
      "GET",
      `/analytics_storage_daily?select=*&${dayFilter(from, to, environment)}`,
    ),
  };
}

export async function getSubscriptionDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  return {
    environment,
    from,
    to,
    mrrIsEstimate: true,
    rows: await serviceRest<Record<string, unknown>[]>(
      env,
      "GET",
      `/analytics_subscription_daily?select=*&${dayFilter(from, to, environment)}`,
    ),
  };
}

export function getAnalyticsMetricCatalog() {
  return ANALYTICS_METRIC_CATALOG;
}

export async function getUserActivityRows(
  env: Env,
  options: AnalyticsQueryOptions,
): Promise<UserActivityDay[]> {
  const { from, to, environment } = range(options);
  return serviceRest<UserActivityDay[]>(
    env,
    "GET",
    `/analytics_user_daily_activity?select=day,user_id,environment,active&${dayFilter(from, to, environment)}&limit=20000`,
  );
}

export async function getUserMilestoneRows(
  env: Env,
  options: { environment?: "production" | "development" } = {},
): Promise<UserMilestone[]> {
  const environment = options.environment ?? "production";
  return serviceRest<UserMilestone[]>(
    env,
    "GET",
    `/analytics_user_milestones?select=user_id,environment,signup_at,first_app_open_at,first_clip_saved_at,first_cloud_upload_at,activated_at,activation_source,activation_quality,last_active_at&environment=eq.${environment}&limit=20000`,
  );
}

export type UserAcquisitionRow = {
  user_id: string;
  anonymous_id: string | null;
  normalized_source: string | null;
  first_touch_source: string | null;
  installer_anonymous_match: boolean;
  first_touch_at: string | null;
};

export async function getUserAcquisitionRows(env: Env): Promise<UserAcquisitionRow[]> {
  return serviceRest<UserAcquisitionRow[]>(
    env,
    "GET",
    "/user_acquisition?select=user_id,anonymous_id,normalized_source,first_touch_source,installer_anonymous_match,first_touch_at&limit=20000",
  );
}

export type GameDailyRow = {
  day: string;
  environment: string;
  game_slug: string;
  game_id: string | null;
  game_name: string;
  cloud_clips: number;
  unique_uploaders: number;
  cloud_bytes: number;
  public_views: number;
  clips_saved: number | null;
  unique_savers: number | null;
  updated_at?: string;
};

export type FeatureDailyRow = {
  day: string;
  environment: string;
  feature_key: string;
  unique_users: number;
  event_count: number;
  repeat_users: number;
  updated_at?: string;
};

export type FilterDailyRow = {
  day: string;
  environment: string;
  filter_id: string;
  selected_count: number;
  applied_count: number;
  rendered_count: number;
  unique_users: number;
  shared_count: number;
  updated_at?: string;
};

export async function getGameDailyRows(env: Env, options: AnalyticsQueryOptions): Promise<GameDailyRow[]> {
  const { from, to, environment } = range(options);
  return serviceRest<GameDailyRow[]>(
    env,
    "GET",
    `/analytics_game_daily?select=*&${dayFilter(from, to, environment)}&limit=20000`,
  );
}

export async function getFeatureDailyRows(env: Env, options: AnalyticsQueryOptions): Promise<FeatureDailyRow[]> {
  const { from, to, environment } = range(options);
  return serviceRest<FeatureDailyRow[]>(
    env,
    "GET",
    `/analytics_feature_daily?select=*&${dayFilter(from, to, environment)}&limit=20000`,
  );
}

export async function getFilterDailyRows(env: Env, options: AnalyticsQueryOptions): Promise<FilterDailyRow[]> {
  const { from, to, environment } = range(options);
  return serviceRest<FilterDailyRow[]>(
    env,
    "GET",
    `/analytics_filter_daily?select=*&${dayFilter(from, to, environment)}&limit=20000`,
  );
}

export async function getFolderDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  return serviceRest<Array<Record<string, unknown>>>(
    env,
    "GET",
    `/analytics_folder_daily?select=*&${dayFilter(from, to, environment)}`,
  );
}

export async function getSharingDailySeries(env: Env, options: AnalyticsQueryOptions) {
  const { from, to, environment } = range(options);
  return serviceRest<Array<Record<string, unknown>>>(
    env,
    "GET",
    `/analytics_sharing_daily?select=*&${dayFilter(from, to, environment)}`,
  );
}

export async function getUserGameFirstRows(env: Env): Promise<
  Array<{ user_id: string; game_slug: string; game_id: string | null; first_ready_at: string }>
> {
  return serviceRest(
    env,
    "GET",
    "/analytics_user_game_first?select=user_id,game_slug,game_id,first_ready_at&environment=eq.production&limit=20000",
  );
}

export type ReadyClipFact = {
  user_id: string;
  duration_ms: number | null;
  visibility: string;
};

export async function getReadyClipFacts(env: Env, options: AnalyticsQueryOptions): Promise<ReadyClipFact[]> {
  const { from, to } = range(options);
  return serviceRest<ReadyClipFact[]>(
    env,
    "GET",
    `/clips?select=user_id,duration_ms,visibility&status=eq.ready&created_at=gte.${from}T00:00:00.000Z&created_at=lt.${to}T00:00:00.000Z&limit=20000`,
  );
}

export async function getPaidUserIds(env: Env): Promise<Set<string>> {
  const rows = await serviceRest<Array<{ user_id: string; plans: { slug: string } | { slug: string }[] | null }>>(
    env,
    "GET",
    "/user_storage?select=user_id,plans!inner(slug)&plans.slug=in.(pro,pro_plus)&limit=20000",
  );
  return new Set(rows.map((row) => row.user_id));
}

export type SubscriptionRow = {
  user_id: string;
  status: string;
  cancel_at_period_end: boolean;
  stripe_price_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  billing_interval: string | null;
  interval_count: number | null;
  created_at: string | null;
};

export async function getBillingSubscriptions(env: Env): Promise<SubscriptionRow[]> {
  return serviceRest<SubscriptionRow[]>(
    env,
    "GET",
    "/billing_subscriptions?select=user_id,status,cancel_at_period_end,stripe_price_id,amount_cents,currency,billing_interval,interval_count,created_at&limit=20000",
  );
}

export async function getActiveGrantUserIds(env: Env): Promise<Set<string>> {
  const rows = await serviceRest<Array<{ user_id: string }>>(
    env,
    "GET",
    `/billing_grants?select=user_id&revoked_at=is.null&or=(expires_at.is.null,expires_at.gt.${new Date().toISOString()})&limit=20000`,
  );
  return new Set(rows.map((row) => row.user_id));
}

export async function getFirstPaidRows(env: Env): Promise<Array<{ user_id: string; first_paid_at: string }>> {
  return serviceRest(env, "GET", "/analytics_user_paid_first?select=user_id,first_paid_at&limit=20000");
}

export async function getCostAssumptions(env: Env): Promise<
  Array<{
    id: string;
    provider: string;
    metric: string;
    unit: string;
    rate: number;
    currency: string;
    effective_from: string;
    notes: string | null;
    updated_at: string;
  }>
> {
  return serviceRest(
    env,
    "GET",
    "/analytics_cost_assumptions?select=id,provider,metric,unit,rate,currency,effective_from,notes,updated_at&order=effective_from.desc&limit=200",
  );
}

export type StorageJoinRow = {
  user_id: string;
  storage_used_bytes: number;
  plans: { slug: string } | { slug: string }[] | null;
};

export async function getStorageUsers(env: Env): Promise<StorageJoinRow[]> {
  return serviceRest<StorageJoinRow[]>(
    env,
    "GET",
    "/user_storage?select=user_id,storage_used_bytes,plans(slug)&limit=20000",
  );
}

export async function getReadyClipCounts(env: Env): Promise<Map<string, number>> {
  const rows = await serviceRest<Array<{ user_id: string }>>(
    env,
    "GET",
    "/clips?select=user_id&status=eq.ready&limit=20000",
  );
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.user_id, (map.get(row.user_id) ?? 0) + 1);
  return map;
}

export async function getFeatureUserIds(
  env: Env,
  eventNames: string[],
  options: AnalyticsQueryOptions,
): Promise<Map<string, Set<string>>> {
  const { from, to, environment } = range(options);
  const rows = await serviceRest<Array<{ user_id: string | null; event_name: string }>>(
    env,
    "GET",
      `/analytics_events?select=user_id,event_name&environment=eq.${environment}&occurred_at=gte.${from}T00:00:00.000Z&occurred_at=lt.${to}T00:00:00.000Z&event_name=in.(${eventNames.map((name) => `"${name}"`).join(",")})&limit=20000`,
  );
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.user_id) continue;
    const set = map.get(row.event_name) ?? new Set<string>();
    set.add(row.user_id);
    map.set(row.event_name, set);
  }
  return map;
}

export async function getFolderUserIds(env: Env): Promise<{ folderUsers: Set<string>; collaborators: Set<string> }> {
  const [folders, members] = await Promise.all([
    serviceRest<Array<{ owner_id: string }>>(env, "GET", "/folders?select=owner_id&limit=20000"),
    serviceRest<Array<{ user_id: string }>>(env, "GET", "/folder_members?select=user_id&limit=20000"),
  ]);
  const collaborators = new Set(members.map((row) => row.user_id));
  const folderUsers = new Set<string>([...folders.map((row) => row.owner_id), ...collaborators]);
  return { folderUsers, collaborators };
}

export type HealthDailyRow = {
  day: string;
  environment: string;
  platform: string;
  app_version: string;
  clip_save_success: number;
  clip_save_failed: number;
  upload_success: number;
  upload_failed: number;
  render_success: number;
  render_failed: number;
  playback_failed: number | null;
  download_failed: number | null;
  error_events: number;
  critical_errors: number;
  unique_affected_users: number;
  updated_at?: string;
};

export async function getHealthDailyRows(env: Env, options: AnalyticsQueryOptions): Promise<HealthDailyRow[]> {
  const { from, to, environment } = range(options);
  return serviceRest<HealthDailyRow[]>(
    env,
    "GET",
    `/analytics_health_daily?select=*&${dayFilter(from, to, environment)}`,
  );
}

export async function getErrorGroups(env: Env, options: AnalyticsQueryOptions) {
  const { from, to } = range(options);
  return serviceRest<
    Array<{
      fingerprint: string;
      surface: string;
      level: string;
      message: string;
      release: string | null;
      count: number;
      first_seen_at: string;
      last_seen_at: string;
      resolved_at: string | null;
      sample_user_id: string | null;
    }>
  >(
    env,
    "GET",
    `/error_events?select=fingerprint,surface,level,message,release,count,first_seen_at,last_seen_at,resolved_at,sample_user_id&last_seen_at=gte.${from}T00:00:00.000Z&last_seen_at=lt.${to}T00:00:00.000Z&order=last_seen_at.desc&limit=80`,
  );
}
