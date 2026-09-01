import {
  attributionCoverage,
  installerSignupConversion,
  sourceLabel,
  type NormalizedSource,
} from "./analyticsAcquisition";
import { ANALYTICS_METRIC_CATALOG, type MetricAvailability } from "./analyticsAvailability";
import {
  addUtcDays,
  comparisonPeriodRange,
  daysInRange,
  formatRangeLabel,
  serializeComparisonRange,
  utcDay,
  type UtcDay,
} from "./analyticsDates";
import {
  ANALYTICS_ACTIVATION_WINDOW_DAYS,
  ANALYTICS_ACTIVATION_WINDOWS_HOURS,
  ANALYTICS_ACTIVITY_AVAILABLE_FROM,
  ANALYTICS_RETENTION_DAYS,
  cohortActivationRate,
  cohortKey,
  cohortRetentionRate,
  dauMauStickiness,
  formatDurationMs,
  inactiveSegments,
  isWindowMature,
  newVsReturning,
  rollingUniqueUsers,
  timeToActivationStats,
  trackedDaysComplete,
  uniqueActiveUsersInRange,
  windowAvailableFrom,
  type CohortKind,
  type UserActivityDay,
} from "./analyticsGrowth";
import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import {
  getDownloadDailySeries,
  getOverviewDailySeries,
  getUserAcquisitionRows,
  getUserActivityRows,
  getUserMilestoneRows,
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
    badge: extras.badge ?? (current === "INCOMPLETE" ? "incomplete" : current === "PROXY" ? "proxy" : null),
    tooltip: extras.tooltip ?? meta.notes,
    unit: extras.unit ?? "count",
    asOf: extras.asOf ?? null,
  };
}

function activityDays(rows: UserActivityDay[]) {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.active === false) continue;
    const set = map.get(row.user_id) ?? new Set<string>();
    set.add(row.day);
    map.set(row.user_id, set);
  }
  return map;
}

function asOfDay(toExclusive: UtcDay, now = new Date()): UtcDay {
  const today = utcDay(now);
  const last = addUtcDays(toExclusive, -1);
  return last < today ? last : today;
}

function funnelStage(name: string, count: number | null, first: number | null, previous: number | null) {
  if (count == null) {
    return { name, count: null, fromPrevious: null, fromFirst: null, availability: "NOT_INSTRUMENTED" as const };
  }
  return {
    name,
    count,
    fromPrevious: previous != null && previous > 0 ? count / previous : null,
    fromFirst: first != null && first > 0 ? count / first : null,
    availability: "AVAILABLE" as const,
  };
}

export async function buildAnalyticsGrowth(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const now = new Date();
  const asOf = asOfDay(query.to, now);
  const lookbackFrom = addUtcDays(query.from, -90);
  const [milestones, activity, overview, downloads, priorActivity] = await Promise.all([
    getUserMilestoneRows(env, { environment: "production" }),
    getUserActivityRows(env, { from: query.from, to: query.to, environment: "production" }),
    getOverviewDailySeries(env, { from: query.from, to: query.to }),
    getDownloadDailySeries(env, { from: query.from, to: query.to }),
    getUserActivityRows(env, { from: lookbackFrom, to: query.to, environment: "production" }),
  ]);
  const previousRange = comparisonPeriodRange(query.comparison);
  const prev = previousRange
    ? await Promise.all([
        getUserMilestoneRows(env, { environment: "production" }),
        getUserActivityRows(env, { from: previousRange.from, to: previousRange.to, environment: "production" }),
        getOverviewDailySeries(env, previousRange),
        getDownloadDailySeries(env, previousRange),
        getUserActivityRows(env, {
          from: addUtcDays(previousRange.from, -90),
          to: previousRange.to,
          environment: "production",
        }),
      ])
    : null;

  const signups = milestones.filter((row) => row.signup_at && row.signup_at >= `${query.from}T00:00:00.000Z` && row.signup_at < `${query.to}T00:00:00.000Z`);
  const prevSignups = prev
    ? prev[0].filter(
        (row) =>
          row.signup_at &&
          row.signup_at >= `${previousRange!.from}T00:00:00.000Z` &&
          row.signup_at < `${previousRange!.to}T00:00:00.000Z`,
      )
    : [];
  const activatedInCohort = signups.filter((row) => row.activated_at);
  const dauMature = asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM;
  const wauMature = isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7, asOf);
  const mauMature = isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30, asOf);
  const dau = dauMature ? uniqueActiveUsersInRange(activity, asOf, addUtcDays(asOf, 1)) : null;
  const wau = wauMature ? rollingUniqueUsers(priorActivity, asOf, 7) : null;
  const mau = mauMature ? rollingUniqueUsers(priorActivity, asOf, 30) : null;
  const prevAsOf = prev && previousRange ? asOfDay(previousRange.to, now) : null;
  const prevDau =
    prev && prevAsOf && prevAsOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM
      ? uniqueActiveUsersInRange(prev[1], prevAsOf, addUtcDays(prevAsOf, 1))
      : null;
  const prevWau = prev && prevAsOf && isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7, prevAsOf) ? rollingUniqueUsers(prev[4], prevAsOf, 7) : null;
  const prevMau = prev && prevAsOf && isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30, prevAsOf) ? rollingUniqueUsers(prev[4], prevAsOf, 30) : null;

  const activationRate = cohortActivationRate(
    signups.map((row) => ({ signup_at: row.signup_at!, activated_at: row.activated_at })),
    ANALYTICS_ACTIVATION_WINDOW_DAYS,
    asOf,
  );
  const prevActivationRate = prev
    ? cohortActivationRate(
        prevSignups.map((row) => ({ signup_at: row.signup_at!, activated_at: row.activated_at })),
        ANALYTICS_ACTIVATION_WINDOW_DAYS,
        prevAsOf ?? asOf,
      )
    : null;

  const byUser = activityDays(priorActivity);
  const signupOrigins = signups
    .filter((row) => row.signup_at)
    .map((row) => ({ user_id: row.user_id, origin_at: row.signup_at! }));
  const d1 = cohortRetentionRate(signupOrigins, byUser, 1, asOf);
  const d7 = cohortRetentionRate(signupOrigins, byUser, 7, asOf);
  const d30 = cohortRetentionRate(signupOrigins, byUser, 30, asOf);

  const installers = downloads.rows.reduce((sum, row) => sum + (Number(row.installer_downloads) || 0), 0);
  const windows = ANALYTICS_ACTIVATION_WINDOWS_HOURS.map((hours) => {
    const eligible = signups.filter((row) => utcDay(new Date(row.signup_at!)) <= addUtcDays(asOf, -Math.ceil(hours / 24)));
    if (!eligible.length) return { hours, rate: null };
    const hit = eligible.filter((row) => row.activated_at && new Date(row.activated_at).getTime() - new Date(row.signup_at!).getTime() <= hours * 3_600_000);
    return { hours, rate: hit.length / eligible.length };
  });

  const timing = timeToActivationStats(signups);
  const nr = newVsReturning(priorActivity, query.from, query.to);
  const segments = inactiveSegments(milestones, now);

  const opened = signups.filter((row) => row.first_app_open_at).length;
  const activated = activatedInCohort.length;
  const uploaded = signups.filter((row) => row.first_cloud_upload_at).length;

  const insights: string[] = [];
  if (d30 == null) insights.push("D30 retention is not mature yet.");
  if (d7 == null) insights.push("D7 retention is not mature yet.");
  if (!wauMature) {
    insights.push(`${trackedDaysComplete(ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf)} of 7 tracking days complete for WAU.`);
  }
  if (!mauMature) {
    insights.push(`${trackedDaysComplete(ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf)} of 30 tracking days complete for MAU.`);
  }
  const day1Window = windows.find((item) => item.hours === 24);
  if (day1Window?.rate != null) {
    insights.push(`${Math.round(day1Window.rate * 100)}% of new users activated within 24 hours.`);
  }
  if (activationRate != null && prevActivationRate != null) {
    const delta = activationRate - prevActivationRate;
    insights.push(`Activation rate ${delta >= 0 ? "increased" : "decreased"} ${Math.abs(Math.round(delta * 100))}% compared with the previous cohort.`);
  }

  const days = daysInRange(query.from, query.to);
  const dauSeries = days.map((day) =>
    day < ANALYTICS_ACTIVITY_AVAILABLE_FROM ? null : uniqueActiveUsersInRange(priorActivity, day, addUtcDays(day, 1)),
  );
  const wauSeries = days.map((day) => (isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7, day) ? rollingUniqueUsers(priorActivity, day, 7) : null));
  const mauSeries = days.map((day) => (isWindowMature(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30, day) ? rollingUniqueUsers(priorActivity, day, 30) : null));

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated: overview.rows.map((row) => String(row.updated_at || "")).filter(Boolean).sort().at(-1) ?? null,
    freshness: "hourly" as const,
    definitions: {
      activeUser:
        "Authenticated user with >=1 qualifying event that UTC day: app.opened, clip.saved, clip.upload_completed, clip.played, clip.editor_opened, clip.rendered, folder.created, folder.clip_added. Not last_sign_in_at. Not marketing clicks, signups, capture.started, replay.enabled, or cron.",
      activation: "First of clip.saved or clip.upload_completed. Historical cloud-only users are cloud_proxy.",
      wau: "Unique users in the selected 7-day window (KPI) or rolling 7-day unique users (chart). Not the sum of DAUs.",
      mau: "Unique users in a 30-day window. Not the sum of DAUs.",
      retention: "Exact calendar day N after signup (or activation on the Retention page).",
      activationWindow: `Within ${ANALYTICS_ACTIVATION_WINDOW_DAYS} days of signup.`,
    },
    tracking: {
      activityAvailableFrom: ANALYTICS_ACTIVITY_AVAILABLE_FROM,
      wauAvailableFrom: windowAvailableFrom(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7),
      mauAvailableFrom: windowAvailableFrom(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 30),
      trackedDays: trackedDaysComplete(ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf),
    },
    metrics: [
      kpi("new_users", "New Users", signups.length, prev ? prevSignups.length : null),
      kpi("activated_users", "Activated Users", activated, prev && previousRange ? prev[0].filter((row) => row.signup_at && row.signup_at >= `${previousRange.from}T00:00:00.000Z` && row.signup_at < `${previousRange.to}T00:00:00.000Z` && row.activated_at).length : null, {
        badge: "incomplete",
        tooltip: "Signup-cohort users who have activated. Historical cloud uploads are labeled cloud_proxy.",
      }),
      kpi("activation_rate_7d", "7-Day Activation Rate", activationRate, prevActivationRate, {
        unit: "percent",
        badge: activationRate == null ? "incomplete" : "incomplete",
      }),
      kpi("dau", "DAU", dau, prevDau, { badge: dauMature ? "incomplete" : "incomplete" }),
      kpi("wau", "WAU", wau, prevWau, {
        badge: "incomplete",
        tooltip: wauMature ? "Rolling 7-day unique users as of the range end." : `${trackedDaysComplete(ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf)} of 7 tracking days complete.`,
      }),
      kpi("mau", "MAU", mau, prevMau, {
        badge: "incomplete",
        tooltip: mauMature ? "Rolling 30-day unique users as of the range end." : `${trackedDaysComplete(ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf)} of 30 tracking days complete.`,
      }),
      kpi("dau_mau", "DAU/MAU", dauMauStickiness(dau, mau), dauMauStickiness(prevDau, prevMau), { unit: "percent" }),
      kpi("retention_d1", "D1 Retention", d1, null, { unit: "percent" }),
      kpi("retention_d7", "D7 Retention", d7, null, { unit: "percent" }),
      kpi("retention_d30", "D30 Retention", d30, null, { unit: "percent" }),
      kpi(
        "installer_downloads",
        "Installer Downloads",
        installers || null,
        prev ? prev[3].rows.reduce((sum, row) => sum + (Number(row.installer_downloads) || 0), 0) || null : null,
      ),
    ],
    timing: {
      exactOnly: true,
      n: timing.n,
      p25: timing.p25,
      median: timing.median,
      p75: timing.p75,
      medianLabel: formatDurationMs(timing.median),
      p25Label: formatDurationMs(timing.p25),
      p75Label: formatDurationMs(timing.p75),
    },
    activationWindows: windows,
    newVsReturning: { newActive: nr.neu, returningActive: nr.returning },
    segments,
    funnel: [
      funnelStage("Account Created", signups.length, signups.length, null),
      funnelStage("First App Open", opened || (asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM ? opened : null), signups.length, signups.length),
      funnelStage("Activated", activated, signups.length, opened || signups.length),
      funnelStage("First Cloud Upload", uploaded, signups.length, activated || uploaded),
      funnelStage("First Share", null, signups.length, uploaded),
      funnelStage("Paid", null, signups.length, null),
    ],
    downloadFunnel: {
      note: "Installer → signup is a period-level ratio unless the same first-party anonymous_id is present on both. Desktop install attribution is not bridged yet.",
      stages: [
        funnelStage(
          "Download Button Click",
          downloads.rows.reduce((sum, row) => sum + (Number(row.app_download_clicks) || 0), 0),
          null,
          null,
        ),
        funnelStage("Installer Download", installers, null, null),
        funnelStage("Signup", signups.length, null, null),
        funnelStage("First App Open", asOf >= ANALYTICS_ACTIVITY_AVAILABLE_FROM ? opened : null, signups.length, signups.length),
        funnelStage("Activated", activated, signups.length, opened || activated),
      ],
    },
    insights,
    series: {
      labels: days,
      dau: dauSeries,
      wau: wauSeries,
      mau: mauSeries,
      new_users: days.map((day) => signups.filter((row) => utcDay(new Date(row.signup_at!)) === day).length),
      activated: days.map((day) => activatedInCohort.filter((row) => row.activated_at && utcDay(new Date(row.activated_at)) === day).length),
    },
  };
}

export async function buildAnalyticsRetention(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const cohort: CohortKind = url.searchParams.get("cohort") === "activation" ? "activation" : "signup";
  const grain = query.granularity === "month" ? "month" : query.granularity === "day" ? "day" : "week";
  const now = new Date();
  const asOf = asOfDay(query.to, now);
  const lookbackFrom = addUtcDays(query.from, -90);
  const [milestones, activity] = await Promise.all([
    getUserMilestoneRows(env, { environment: "production" }),
    getUserActivityRows(env, { from: lookbackFrom, to: addUtcDays(asOf, 1), environment: "production" }),
  ]);
  const byUser = activityDays(activity);
  const members = milestones
    .map((row) => {
      const origin = cohort === "activation" ? row.activated_at : row.signup_at;
      return origin ? { user_id: row.user_id, origin_at: origin } : null;
    })
    .filter((row): row is { user_id: string; origin_at: string } => Boolean(row))
    .filter((row) => row.origin_at >= `${query.from}T00:00:00.000Z` && row.origin_at < `${query.to}T00:00:00.000Z`);

  const groups = new Map<string, Array<{ user_id: string; origin_at: string }>>();
  for (const member of members) {
    const key = cohortKey(member.origin_at, grain);
    const list = groups.get(key) ?? [];
    list.push(member);
    groups.set(key, list);
  }

  const rows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const lastOrigin = group.reduce((max, item) => (item.origin_at > max ? item.origin_at : max), group[0]!.origin_at);
      const lastDay = utcDay(new Date(lastOrigin));
      const rates: Record<string, number | null> = {};
      for (const n of ANALYTICS_RETENTION_DAYS) {
        rates[`d${n}`] = cohortRetentionRate(group, byUser, n, asOf);
        if (!asOf || asOf <= addUtcDays(lastDay, n)) rates[`d${n}`] = null;
      }
      return { cohort: key, users: group.length, lastOrigin: lastDay, ...rates };
    });

  const selected = members;
  const curve = [0, ...ANALYTICS_RETENTION_DAYS].map((n) => ({
    day: n,
    rate: n === 0 ? (selected.length ? 1 : null) : cohortRetentionRate(selected, byUser, n, asOf),
  }));

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: grain,
      cohort,
    },
    comparisonRange: null,
    lastUpdated: null,
    freshness: "hourly" as const,
    definition: {
      retention: "Exact calendar day N after the cohort origin. Immature periods are null, never 0%.",
      week: "Monday–Sunday UTC.",
      maturity: "A D_n cell is mature after every member's day N has ended.",
    },
    tracking: {
      activityAvailableFrom: ANALYTICS_ACTIVITY_AVAILABLE_FROM,
      notice:
        asOf < addUtcDays(ANALYTICS_ACTIVITY_AVAILABLE_FROM, 7)
          ? `Qualifying activity instrumentation began ${ANALYTICS_ACTIVITY_AVAILABLE_FROM}. Immature periods show —.`
          : null,
    },
    periods: ANALYTICS_RETENTION_DAYS,
    rows,
    curve,
  };
}

export async function buildAnalyticsAcquisition(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const now = new Date();
  const asOf = asOfDay(query.to, now);
  const [milestones, acquisition, downloads] = await Promise.all([
    getUserMilestoneRows(env, { environment: "production" }),
    getUserAcquisitionRows(env),
    getDownloadDailySeries(env, { from: query.from, to: query.to }),
  ]);
  const signups = milestones.filter((row) => row.signup_at && row.signup_at >= `${query.from}T00:00:00.000Z` && row.signup_at < `${query.to}T00:00:00.000Z`);
  const byUser = new Map(acquisition.map((row) => [row.user_id, row]));
  let known = 0;
  let unknown = 0;
  let direct = 0;
  const bySource = new Map<string, { signups: number; activated: number; installerMatches: number }>();
  for (const user of signups) {
    const row = byUser.get(user.user_id);
    const source = (row?.normalized_source || "unknown") as NormalizedSource;
    if (source === "unknown") unknown += 1;
    else known += 1;
    if (source === "direct") direct += 1;
    const bucket = bySource.get(source) ?? { signups: 0, activated: 0, installerMatches: 0 };
    bucket.signups += 1;
    if (user.activated_at) bucket.activated += 1;
    if (row?.installer_anonymous_match) bucket.installerMatches += 1;
    bySource.set(source, bucket);
  }
  const installers = downloads.rows.reduce((sum, row) => sum + (Number(row.installer_downloads) || 0), 0);
  const matches = acquisition.filter((row) => row.installer_anonymous_match && signups.some((user) => user.user_id === row.user_id)).length;
  const conversion = installerSignupConversion({
    attributedSignups: signups.length,
    installerDownloads: installers,
    userLevelMatches: matches,
  });

  return {
    range: {
      from: query.from,
      to: query.to,
      label: formatRangeLabel(query.from, query.to),
      tz: query.tz,
      preset: query.preset,
      granularity: query.granularity,
    },
    comparisonRange: serializeComparisonRange(query.comparison),
    lastUpdated: null,
    freshness: "hourly" as const,
    coverage: {
      newUsers: signups.length,
      attributed: known,
      unknown,
      direct,
      rate: attributionCoverage(known, signups.length),
      note: "Unknown means no first-party first-touch was captured. Direct is a known landing without UTM/referrer. They are not merged. Desktop-only signups are usually Unknown until install attribution is bridged.",
    },
    conversion: {
      ...conversion,
      installerDownloads: installers,
      userLevelMatches: matches,
      note:
        conversion.label === "user-level"
          ? "User-level: same first-party anonymous_id on installer download and signup."
          : "Period-level ratio only. Installer → desktop identity is not bridged.",
    },
    sources: [...bySource.entries()]
      .sort((a, b) => b[1].signups - a[1].signups)
      .map(([source, stats]) => ({
        source,
        label: sourceLabel(source as NormalizedSource),
        signups: stats.signups,
        activated: stats.activated,
        activationRate: stats.signups > 0 ? stats.activated / stats.signups : null,
        installerMatches: stats.installerMatches,
        shareOfAttributed: known > 0 && source !== "unknown" ? stats.signups / known : null,
        shareOfAll: signups.length > 0 ? stats.signups / signups.length : null,
      })),
    tracking: { activityAvailableFrom: ANALYTICS_ACTIVITY_AVAILABLE_FROM, asOf },
  };
}

