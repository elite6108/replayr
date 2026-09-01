import { ANALYTICS_METRIC_CATALOG, type MetricAvailability } from "./analyticsAvailability";
import { addUtcDays, comparisonPeriodRange, daysInRange, formatRangeLabel, serializeComparisonRange, utcDay, type UtcDay } from "./analyticsDates";
import { uniqueActiveUsersInRange, type UserActivityDay } from "./analyticsGrowth";
import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import {
  CLIP_COUNT_BUCKETS,
  DURATION_BUCKETS,
  FEATURE_ADOPTION_ONLY,
  FEATURE_LABELS,
  UNKNOWN_GAME_SLUG,
  adoptionRate,
  clipsPerActiveUser,
  engagementRate,
  gameLabel,
  gameRetentionRows,
  histogram,
  isUsedFilter,
  paidShare,
  powerUserIds,
  repeatRate,
  shareOf,
} from "./analyticsProduct";
import {
  getClipDailySeries,
  getDownloadDailySeries,
  getFeatureDailyRows,
  getFilterDailyRows,
  getFolderDailySeries,
  getGameDailyRows,
  getPaidUserIds,
  getReadyClipFacts,
  getSharingDailySeries,
  getUserActivityRows,
  getUserGameFirstRows,
  getFolderUserIds,
  type FeatureDailyRow,
  type FilterDailyRow,
  type GameDailyRow,
} from "./analyticsQueries";
import type { Env } from "./env";

function catalog(key: string): { availability: MetricAvailability; notes: string } {
  const row = ANALYTICS_METRIC_CATALOG.find((item) => item.key === key);
  return { availability: row?.availability ?? "NOT_INSTRUMENTED", notes: row?.notes ?? "" };
}

function kpi(
  key: string,
  label: string,
  value: number | null,
  previous: number | null,
  extras: Partial<AnalyticsKpi> = {},
): AnalyticsKpi {
  const meta = catalog(key);
  const current = extras.availability ?? meta.availability;
  return {
    key,
    label,
    value,
    previous,
    absoluteChange: value != null && previous != null ? value - previous : null,
    percentageChange:
      previous == null || previous === 0 ? (value != null && previous === 0 && value > 0 ? "new" : null) : (value! - previous) / previous,
    availability: current,
    badge: extras.badge ?? (current === "INCOMPLETE" ? "incomplete" : current === "PROXY" ? "proxy" : current === "NOT_INSTRUMENTED" ? null : null),
    tooltip: extras.tooltip ?? meta.notes,
    unit: extras.unit ?? "count",
    asOf: extras.asOf ?? null,
  };
}

function asOfDay(toExclusive: UtcDay, now = new Date()): UtcDay {
  const today = utcDay(now);
  const last = addUtcDays(toExclusive, -1);
  return last < today ? last : today;
}

function sum(rows: Array<Record<string, unknown>>, key: string): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = Number(row[key]);
    if (!Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function activityMap(rows: UserActivityDay[]) {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.active === false) continue;
    const set = map.get(row.user_id) ?? new Set<string>();
    set.add(row.day);
    map.set(row.user_id, set);
  }
  return map;
}

function rangeMeta(query: ReturnType<typeof parseAdminAnalyticsQuery>) {
  return {
    from: query.from,
    to: query.to,
    label: formatRangeLabel(query.from, query.to, query.preset, query.granularity),
    tz: query.tz,
    preset: query.preset,
    granularity: query.granularity,
  };
}

export async function buildAnalyticsClips(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const [clips, activity, facts, paid] = await Promise.all([
    getClipDailySeries(env, { from: query.from, to: query.to }),
    getUserActivityRows(env, { from: query.from, to: query.to, environment: "production" }),
    getReadyClipFacts(env, { from: query.from, to: query.to }),
    getPaidUserIds(env),
  ]);
  const previousRange = comparisonPeriodRange(query.comparison);
  const prev = previousRange
    ? await Promise.all([
        getClipDailySeries(env, previousRange),
        getReadyClipFacts(env, previousRange),
      ])
    : null;
  const active = uniqueActiveUsersInRange(activity, query.from, query.to);
  const saved = sum(clips.rows, "clips_saved");
  const prevSaved = prev ? sum(prev[0].rows, "clips_saved") : null;
  const ready = facts.length;
  const prevReady = prev?.[1].length ?? null;
  const failed = sum(clips.rows, "clip_save_failed");
  const rendered = sum(clips.rows, "clips_rendered");
  const shared = sum(clips.rows, "clips_shared");
  const perUser = new Map<string, number>();
  const durations: number[] = [];
  const visibility = { public: 0, unlisted: 0, private: 0 };
  for (const clip of facts) {
    perUser.set(clip.user_id, (perUser.get(clip.user_id) ?? 0) + 1);
    if (clip.duration_ms != null) durations.push(clip.duration_ms);
    if (clip.visibility === "public" || clip.visibility === "unlisted" || clip.visibility === "private") {
      visibility[clip.visibility] += 1;
    }
  }
  const counts = [...perUser.entries()].map(([user_id, count]) => ({ user_id, count }));
  const power = powerUserIds(counts);
  const labels = daysInRange(query.from, query.to);
  return {
    range: rangeMeta(query),
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated: clips.rows.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      clips_saved: "Local clip.saved after a successful desktop save.",
      cloud_clips: "Ready cloud clips created in the range.",
      power_users: "Top decile of ready cloud clips in the selected range.",
    },
    metrics: [
      kpi("clips_saved", "Clips saved", saved, prevSaved),
      kpi("ready_cloud_clips", "Ready cloud clips", ready, prevReady, { availability: "AVAILABLE" }),
      kpi("clips_per_active_user", "Clips saved / DAU", clipsPerActiveUser(saved, active), null),
      kpi("clip_save_failed", "Save failures", failed, prev ? sum(prev[0].rows, "clip_save_failed") : null, {
        availability: saved != null || failed != null ? "AVAILABLE" : "INCOMPLETE",
      }),
      kpi("clips_rendered", "Renders", rendered, prev ? sum(prev[0].rows, "clips_rendered") : null, {
        availability: "INCOMPLETE",
      }),
      kpi("clips_shared", "Shares", shared, prev ? sum(prev[0].rows, "clips_shared") : null),
      kpi("power_users", "Power users", power.length, null),
    ],
    distributions: {
      clipsPerUser: histogram(counts.map((row) => row.count), [...CLIP_COUNT_BUCKETS]),
      duration: histogram(durations, [...DURATION_BUCKETS]),
      visibility,
    },
    powerUsers: {
      count: power.length,
      paidShare: paidShare(power, paid),
      medianClips: counts.length ? counts.map((row) => row.count).sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? null : null,
      note: "Power users are the top decile of ready cloud clips in this range. Not a revenue segment.",
    },
    series: {
      labels,
      clips_saved: labels.map((day) => {
        const row = clips.rows.find((item) => item.day === day);
        return row?.clips_saved == null ? null : Number(row.clips_saved);
      }),
      ready_cloud_clips: labels.map((day) => {
        const row = clips.rows.find((item) => item.day === day);
        return row?.ready_cloud_clips_created == null ? null : Number(row.ready_cloud_clips_created);
      }),
    },
  };
}

function rollupGames(rows: GameDailyRow[]) {
  const map = new Map<string, { slug: string; name: string; cloud: number; uploaders: number; views: number; saved: number | null }>();
  for (const row of rows) {
    const current = map.get(row.game_slug) ?? {
      slug: row.game_slug,
      name: gameLabel(row.game_slug, row.game_name),
      cloud: 0,
      uploaders: 0,
      views: 0,
      saved: null,
    };
    current.cloud += Number(row.cloud_clips || 0);
    current.uploaders += Number(row.unique_uploaders || 0);
    current.views += Number(row.public_views || 0);
    if (row.clips_saved != null) current.saved = (current.saved ?? 0) + Number(row.clips_saved);
    map.set(row.game_slug, current);
  }
  return [...map.values()].sort((a, b) => b.cloud - a.cloud || b.views - a.views);
}

export async function buildAnalyticsGames(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const asOf = asOfDay(query.to);
  const [games, firsts, activity] = await Promise.all([
    getGameDailyRows(env, { from: query.from, to: query.to }),
    getUserGameFirstRows(env),
    getUserActivityRows(env, { from: addUtcDays(query.from, -90), to: query.to, environment: "production" }),
  ]);
  const rolled = rollupGames(games);
  const retention = gameRetentionRows(firsts, activityMap(activity), asOf, 7);
  const retentionBySlug = new Map(retention.map((row) => [row.game_slug, row]));
  const unknown = rolled.find((row) => row.slug === UNKNOWN_GAME_SLUG);
  return {
    range: rangeMeta(query),
    comparisonRange: null,
    lastUpdated: games.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      games: "Normalized games.slug. Unknown is a missing game_id, not Direct.",
      retention: "Exact calendar day 7 after the user's first ready cloud clip of that game.",
    },
    metrics: [
      kpi("top_games", "Games with clips", rolled.filter((row) => row.cloud > 0).length, null),
      kpi("ready_cloud_clips", "Ready cloud clips", rolled.reduce((sum, row) => sum + row.cloud, 0), null, {
        availability: "AVAILABLE",
      }),
      kpi("unknown_game_share", "Unknown game share", shareOf(unknown?.cloud ?? 0, rolled.reduce((sum, row) => sum + row.cloud, 0)), null, {
        unit: "percent",
        availability: "AVAILABLE",
      }),
    ],
    games: rolled.map((row) => {
      const ret = retentionBySlug.get(row.slug);
      return {
        slug: row.slug,
        name: row.name,
        cloudClips: row.cloud,
        uniqueUploaders: row.uploaders,
        publicViews: row.views,
        clipsSaved: row.saved,
        retentionD7: ret?.rate ?? null,
        retentionEligible: ret?.eligible ?? 0,
        retentionUsers: ret?.users ?? 0,
      };
    }),
    insights: [
      rolled[0] && rolled[0].cloud > 0 ? `${rolled[0].name} produced the most ready cloud clips.` : "No ready cloud clips in this range.",
      unknown && unknown.cloud > 0 ? `${unknown.cloud} clips have no game. Unknown is not merged with a named game.` : null,
    ].filter((item): item is string => Boolean(item)),
  };
}

function rollupFeatures(rows: FeatureDailyRow[]) {
  const map = new Map<string, { unique: number; events: number; repeat: number }>();
  for (const row of rows) {
    const current = map.get(row.feature_key) ?? { unique: 0, events: 0, repeat: 0 };
    current.unique += Number(row.unique_users || 0);
    current.events += Number(row.event_count || 0);
    current.repeat += Number(row.repeat_users || 0);
    map.set(row.feature_key, current);
  }
  return map;
}

function rollupFilters(rows: FilterDailyRow[]) {
  const map = new Map<string, FilterDailyRow>();
  for (const row of rows) {
    const current = map.get(row.filter_id) ?? {
      day: "",
      environment: row.environment,
      filter_id: row.filter_id,
      selected_count: 0,
      applied_count: 0,
      rendered_count: 0,
      unique_users: 0,
      shared_count: 0,
    };
    current.selected_count += Number(row.selected_count || 0);
    current.applied_count += Number(row.applied_count || 0);
    current.rendered_count += Number(row.rendered_count || 0);
    current.unique_users += Number(row.unique_users || 0);
    current.shared_count += Number(row.shared_count || 0);
    map.set(row.filter_id, current);
  }
  return [...map.values()].sort((a, b) => b.rendered_count - a.rendered_count || b.applied_count - a.applied_count);
}

export async function buildAnalyticsFeatures(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const [features, filters, activity, facts, paid] = await Promise.all([
    getFeatureDailyRows(env, { from: query.from, to: query.to }),
    getFilterDailyRows(env, { from: query.from, to: query.to }),
    getUserActivityRows(env, { from: query.from, to: query.to, environment: "production" }),
    getReadyClipFacts(env, { from: query.from, to: query.to }),
    getPaidUserIds(env),
  ]);
  const active = uniqueActiveUsersInRange(activity, query.from, query.to);
  const rolled = rollupFeatures(features);
  const filterRows = rollupFilters(filters);
  const usedFilters = filterRows.filter((row) => isUsedFilter(row.filter_id));
  const power = powerUserIds(facts.reduce<Array<{ user_id: string; count: number }>>((list, clip) => {
    const existing = list.find((row) => row.user_id === clip.user_id);
    if (existing) existing.count += 1;
    else list.push({ user_id: clip.user_id, count: 1 });
    return list;
  }, []));
  return {
    range: rangeMeta(query),
    lastUpdated: features.at(-1)?.updated_at ?? filters.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      adoption: "Unique users with that feature / active users in the range.",
      capture: "Capture and Instant Replay are adoption-only. They are not DAU.",
      filters: "none is stored and excluded from “used” totals.",
    },
    metrics: [
      kpi("feature_adoption", "Features with users", [...rolled.values()].filter((row) => row.unique > 0).length, null),
      kpi("top_filters", "Used filters", usedFilters.length, null),
      kpi("power_users", "Power users", power.length, null),
    ],
    features: Object.keys(FEATURE_LABELS).map((key) => {
      const row = rolled.get(key) ?? { unique: 0, events: 0, repeat: 0 };
      return {
        key,
        label: FEATURE_LABELS[key],
        uniqueUsers: row.unique,
        eventCount: row.events,
        repeatUsers: row.repeat,
        adoption: adoptionRate(row.unique, active),
        repeatRate: repeatRate(row.repeat, row.unique),
        dau: !FEATURE_ADOPTION_ONLY.has(key),
      };
    }),
    filters: filterRows.map((row) => ({
      id: row.filter_id,
      used: isUsedFilter(row.filter_id),
      selected: Number(row.selected_count || 0),
      applied: Number(row.applied_count || 0),
      rendered: Number(row.rendered_count || 0),
      uniqueUsers: Number(row.unique_users || 0),
      shared: Number(row.shared_count || 0),
    })),
    powerUsers: {
      count: power.length,
      paidShare: paidShare(power, paid),
      note: "Paid share is a product correlation, not a revenue metric.",
    },
  };
}

export async function buildAnalyticsFolders(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const [folders, activity, people, paid] = await Promise.all([
    getFolderDailySeries(env, { from: query.from, to: query.to }),
    getUserActivityRows(env, { from: query.from, to: query.to, environment: "production" }),
    getFolderUserIds(env),
    getPaidUserIds(env),
  ]);
  const created = sum(folders, "folders_created") ?? 0;
  const added = sum(folders, "clips_added") ?? 0;
  const invites = sum(folders, "invites_sent") ?? 0;
  const accepted = sum(folders, "invites_accepted") ?? 0;
  const publicLinks = sum(folders, "public_links_enabled") ?? 0;
  const latest = folders.at(-1);
  const folderEngagement = engagementRate(people.folderUsers, activity, query.from, query.to);
  const collabEngagement = engagementRate(people.collaborators, activity, query.from, query.to);
  const others = activity.map((row) => row.user_id).filter((id) => !people.folderUsers.has(id));
  const otherEngagement = engagementRate(others, activity, query.from, query.to);
  return {
    range: rangeMeta(query),
    lastUpdated: latest?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      folder_user: "Owner of any folder or a folder_members row.",
      collaborator: "folder_members only. Owners are not stored as members.",
    },
    metrics: [
      kpi("folder_adoption", "Folders created", created, null),
      kpi("folder_clips_added", "Clips added", added, null, { availability: "AVAILABLE" }),
      kpi("folder_invites", "Invites sent", invites, null, { availability: "AVAILABLE" }),
      kpi("folder_invites_accepted", "Invites accepted", accepted, null, { availability: "AVAILABLE" }),
      kpi("folder_public_links", "Public links enabled", publicLinks, null, { availability: "AVAILABLE" }),
      kpi("folder_user_engagement", "Folder-user active rate", folderEngagement, otherEngagement, { unit: "percent" }),
    ],
    snapshot: {
      uniqueOwners: Number(latest?.unique_owners || 0),
      uniqueCollaborators: Number(latest?.unique_collaborators || 0),
      uniqueFolderUsers: Number(latest?.unique_folder_users || 0),
    },
    engagement: {
      folderUsers: folderEngagement,
      collaborators: collabEngagement,
      others: otherEngagement,
      folderPaidShare: paidShare(people.folderUsers, paid),
      collaboratorPaidShare: paidShare(people.collaborators, paid),
      note: "Active rate is unique actives in the range / people in the segment. Immature DAU stays incomplete.",
    },
  };
}

export async function buildAnalyticsSharing(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const [sharing, downloads] = await Promise.all([
    getSharingDailySeries(env, { from: query.from, to: query.to }),
    getDownloadDailySeries(env, { from: query.from, to: query.to }),
  ]);
  const shared = sum(sharing, "clips_shared");
  const views = sum(sharing, "public_clip_views") ?? 0;
  const publicDownloads = sum(downloads.rows, "clip_downloads_public");
  const folderDownloads = sum(downloads.rows, "folder_public_downloads");
  const installers = sum(downloads.rows, "installer_downloads");
  return {
    range: rangeMeta(query),
    lastUpdated: sharing.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      share: "clip.shared after a successful DM send or copy-link. Not a public visibility change.",
      virality: "Public views and public downloads are available. Shared identity is not stitched to installer downloads.",
    },
    metrics: [
      kpi("clips_shared", "Clip shares", shared, null),
      kpi("public_clip_views", "Public clip views", views, null, { availability: "AVAILABLE" }),
      kpi("clip_downloads_public", "Public clip downloads", publicDownloads, null),
      kpi("folder_public_downloads", "Public folder downloads", folderDownloads, null),
      kpi("share_to_download", "Share → installer", null, null, { availability: "NOT_INSTRUMENTED" }),
    ],
    conversion: {
      viewsToPublicDownload: shareOf(publicDownloads ?? 0, views),
      installerDownloads: installers,
      note: "Period-level only. A public view is not proven to cause an app download.",
    },
    series: {
      labels: daysInRange(query.from, query.to),
      shares: daysInRange(query.from, query.to).map((day) => {
        const row = sharing.find((item) => item.day === day);
        return row?.clips_shared == null ? null : Number(row.clips_shared);
      }),
      views: daysInRange(query.from, query.to).map((day) => {
        const row = sharing.find((item) => item.day === day);
        return row?.public_clip_views == null ? null : Number(row.public_clip_views);
      }),
    },
  };
}
