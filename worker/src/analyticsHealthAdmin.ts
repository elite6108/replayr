import { ANALYTICS_METRIC_CATALOG, type MetricAvailability } from "./analyticsAvailability";
import { comparisonPeriodRange, daysInRange, formatRangeLabel, serializeComparisonRange } from "./analyticsDates";
import { parseAdminAnalyticsQuery, type AnalyticsKpi } from "./analyticsAdmin";
import {
  classifyErrorStatus,
  failureRate,
  healthInsights,
  HEALTH_INCIDENT_CRITICAL_USERS,
  HEALTH_INCIDENT_MIN_SAMPLE,
  HEALTH_INCIDENT_UPLOAD_RATE,
  HEALTH_REGRESSION_MIN_SAMPLE,
  isPotentialRegression,
  successRate,
  type HealthTotals,
} from "./analyticsHealth";
import { getErrorGroups, getHealthDailyRows, type HealthDailyRow } from "./analyticsQueries";
import type { Env } from "./env";

function catalog(key: string) {
  const row = ANALYTICS_METRIC_CATALOG.find((item) => item.key === key);
  return { availability: (row?.availability ?? "NOT_INSTRUMENTED") as MetricAvailability, notes: row?.notes ?? "" };
}

function kpi(key: string, label: string, value: number | null, previous: number | null, extras: Partial<AnalyticsKpi> = {}): AnalyticsKpi {
  const meta = catalog(key);
  const availability = extras.availability ?? meta.availability;
  return {
    key,
    label,
    value,
    previous,
    absoluteChange: value != null && previous != null ? value - previous : null,
    percentageChange:
      previous == null || previous === 0 ? (value != null && previous === 0 && value > 0 ? "new" : null) : (value! - previous) / previous,
    availability,
    badge: extras.badge ?? (availability === "INCOMPLETE" ? "incomplete" : availability === "AVAILABLE_ESTIMATE" ? "estimate" : null),
    tooltip: extras.tooltip ?? meta.notes,
    unit: extras.unit ?? "percent",
    asOf: extras.asOf ?? null,
  };
}

function totals(rows: HealthDailyRow[]): HealthTotals {
  return rows.reduce(
    (sum, row) => ({
      clipSaveSuccess: sum.clipSaveSuccess + Number(row.clip_save_success || 0),
      clipSaveFailed: sum.clipSaveFailed + Number(row.clip_save_failed || 0),
      uploadSuccess: sum.uploadSuccess + Number(row.upload_success || 0),
      uploadFailed: sum.uploadFailed + Number(row.upload_failed || 0),
      renderSuccess: sum.renderSuccess + Number(row.render_success || 0),
      renderFailed: sum.renderFailed + Number(row.render_failed || 0),
      errorEvents: sum.errorEvents + Number(row.error_events || 0),
      criticalErrors: sum.criticalErrors + Number(row.critical_errors || 0),
      uniqueAffectedUsers: sum.uniqueAffectedUsers + Number(row.unique_affected_users || 0),
    }),
    {
      clipSaveSuccess: 0,
      clipSaveFailed: 0,
      uploadSuccess: 0,
      uploadFailed: 0,
      renderSuccess: 0,
      renderFailed: 0,
      errorEvents: 0,
      criticalErrors: 0,
      uniqueAffectedUsers: 0,
    },
  );
}

function rollupBy(rows: HealthDailyRow[], key: "app_version" | "platform") {
  const map = new Map<string, HealthDailyRow[]>();
  for (const row of rows) {
    const value = String(row[key] || "");
    if (!value) continue;
    const list = map.get(value) ?? [];
    list.push(row);
    map.set(value, list);
  }
  return [...map.entries()].map(([label, group]) => ({ label, ...totals(group) }));
}

export async function buildAnalyticsHealth(env: Env, url: URL) {
  const query = parseAdminAnalyticsQuery(url);
  const previousRange = comparisonPeriodRange(query.comparison);
  const [current, previous, errors] = await Promise.all([
    getHealthDailyRows(env, { from: query.from, to: query.to }),
    previousRange ? getHealthDailyRows(env, previousRange) : Promise.resolve([]),
    getErrorGroups(env, { from: query.from, to: query.to }),
  ]);
  const all = current.filter((row) => row.platform === "" && row.app_version === "");
  const prevAll = previous.filter((row) => row.platform === "" && row.app_version === "");
  const now = totals(all);
  const was = totals(prevAll);
  const saveRate = successRate(now.clipSaveSuccess, now.clipSaveFailed);
  const uploadRate = successRate(now.uploadSuccess, now.uploadFailed);
  const renderRate = successRate(now.renderSuccess, now.renderFailed);
  const uploadFail = failureRate(now.uploadSuccess, now.uploadFailed);
  const prevUploadFail = failureRate(was.uploadSuccess, was.uploadFailed);
  const versions = rollupBy(current, "app_version").sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
  const latest = versions[0] ?? null;
  const prior = versions[1] ?? null;
  const saveRegression = Boolean(
    latest &&
      prior &&
      isPotentialRegression(
        { failed: latest.clipSaveFailed, total: latest.clipSaveSuccess + latest.clipSaveFailed },
        { failed: prior.clipSaveFailed, total: prior.clipSaveSuccess + prior.clipSaveFailed },
      ),
  );
  const newGroups = errors.filter((row) => classifyErrorStatus({
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    from: query.from,
    to: query.to,
  }) === "New");
  const attention: string[] = [];
  if (
    uploadFail != null &&
    now.uploadSuccess + now.uploadFailed >= HEALTH_INCIDENT_MIN_SAMPLE &&
    uploadFail > HEALTH_INCIDENT_UPLOAD_RATE
  ) {
    attention.push("Upload failure rate is above the 5% baseline.");
  }
  if (now.criticalErrors > 0 && now.uniqueAffectedUsers >= HEALTH_INCIDENT_CRITICAL_USERS) {
    attention.push(`Critical errors affected ${now.uniqueAffectedUsers} sampled users.`);
  }
  if (saveRegression && latest && prior) {
    attention.push(`Replayr ${latest.label} may have a clip-save regression vs ${prior.label}.`);
  }
  const labels = daysInRange(query.from, query.to);
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
    lastUpdated: all.at(-1)?.updated_at ?? null,
    freshness: "hourly" as const,
    definitions: {
      clipSave: "clip.saved / (clip.saved + clip.save_failed). Cancelled saves are excluded.",
      upload: "Terminal clip.upload_completed / (completed + failed). Retryable 502 is not a failure.",
      render: "clip.rendered / (rendered + clip.render_failed). User cancellations are not emitted.",
      errors: "Grouped error_events. Stacks stay on the Errors admin page.",
      regression: `Potential regression only when both versions have ≥${HEALTH_REGRESSION_MIN_SAMPLE} operations and failure rises ≥25% relative and ≥1pp absolute.`,
    },
    metrics: [
      kpi("clip_save_success_rate", "Clip Save Success", saveRate, successRate(was.clipSaveSuccess, was.clipSaveFailed)),
      kpi("upload_success_rate", "Upload Success", uploadRate, successRate(was.uploadSuccess, was.uploadFailed), { availability: "AVAILABLE" }),
      kpi("render_success_rate", "Render Success", renderRate, successRate(was.renderSuccess, was.renderFailed)),
      kpi("unique_affected_users", "Affected Users", now.uniqueAffectedUsers || null, was.uniqueAffectedUsers || null, { unit: "count" }),
      kpi("error_events", "Errors", now.errorEvents || null, was.errorEvents || null, { unit: "count" }),
      kpi("critical_errors", "Critical Errors", now.criticalErrors || null, was.criticalErrors || null, { unit: "count" }),
      kpi("new_error_groups", "New Error Groups", newGroups.length || null, null, { unit: "count", availability: "AVAILABLE" }),
    ],
    attention,
    insights: healthInsights({
      uploadRate: uploadFail,
      previousUploadRate: prevUploadFail,
      versionLabel: latest?.label ?? null,
      previousVersionLabel: prior?.label ?? null,
      saveRegression,
      newErrorGroupCount: newGroups.length,
      affectedUserCount: new Set(newGroups.map((row) => row.sample_user_id).filter(Boolean)).size,
      newErrorLabel: newGroups[0]?.message ?? null,
    }),
    releases: versions.map((row, index) => {
      const compare = versions[index + 1];
      const saveFail = failureRate(row.clipSaveSuccess, row.clipSaveFailed);
      const prevSaveFail = compare ? failureRate(compare.clipSaveSuccess, compare.clipSaveFailed) : null;
      const regression =
        compare &&
        isPotentialRegression(
          { failed: row.clipSaveFailed, total: row.clipSaveSuccess + row.clipSaveFailed },
          { failed: compare.clipSaveFailed, total: compare.clipSaveSuccess + compare.clipSaveFailed },
        );
      return {
        version: row.label,
        clipSaves: row.clipSaveSuccess + row.clipSaveFailed,
        saveSuccess: successRate(row.clipSaveSuccess, row.clipSaveFailed),
        uploads: row.uploadSuccess + row.uploadFailed,
        uploadSuccess: successRate(row.uploadSuccess, row.uploadFailed),
        renders: row.renderSuccess + row.renderFailed,
        renderSuccess: successRate(row.renderSuccess, row.renderFailed),
        errors: row.errorEvents,
        affectedUsers: row.uniqueAffectedUsers,
        potentialRegression: Boolean(regression),
        comparedTo: compare?.label ?? null,
        saveFailureDelta: saveFail != null && prevSaveFail != null ? saveFail - prevSaveFail : null,
      };
    }),
    platforms: rollupBy(current, "platform").map((row) => ({
      platform: row.label,
      clipSaveSuccess: successRate(row.clipSaveSuccess, row.clipSaveFailed),
      uploadSuccess: successRate(row.uploadSuccess, row.uploadFailed),
      renderSuccess: successRate(row.renderSuccess, row.renderFailed),
      errors: row.errorEvents,
    })),
    errors: errors.map((row) => ({
      fingerprint: row.fingerprint,
      message: row.message,
      occurrences: row.count,
      affectedUsers: row.sample_user_id ? 1 : 0,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      versions: row.release ? [row.release] : [],
      platforms: [row.surface],
      status: classifyErrorStatus({
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        resolvedAt: row.resolved_at,
        from: query.from,
        to: query.to,
      }),
      href: `/admin/errors`,
    })),
    games: {
      note: "Failure rates by game need game_slug on failure events. clip.save_failed does not carry game yet.",
      rows: [] as Array<{ slug: string; attempts: number; saveFailure: number | null }>,
    },
    features: {
      note: "Feature failure rates need the same event lineage (webcam/filter on the failed event). Not fabricated from user-level usage.",
      rows: [] as Array<{ key: string; label: string; failureRate: number | null }>,
    },
    series: {
      labels,
      uploadFailed: labels.map((day) => numOn(all, day, "upload_failed")),
      saveFailed: labels.map((day) => numOn(all, day, "clip_save_failed")),
      errors: labels.map((day) => numOn(all, day, "error_events")),
    },
  };
}

function numOn(rows: HealthDailyRow[], day: string, key: keyof HealthDailyRow): number | null {
  const row = rows.find((item) => item.day === day);
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : null;
}

export async function buildAnalyticsHealthReleases(env: Env, url: URL) {
  const health = await buildAnalyticsHealth(env, url);
  return { range: health.range, releases: health.releases, definitions: { regression: health.definitions.regression } };
}
