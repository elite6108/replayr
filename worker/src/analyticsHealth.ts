export const HEALTH_REGRESSION_MIN_SAMPLE = 100;
export const HEALTH_REGRESSION_RELATIVE = 0.25;
export const HEALTH_REGRESSION_ABSOLUTE = 0.01;
export const HEALTH_INCIDENT_UPLOAD_RATE = 0.05;
export const HEALTH_INCIDENT_MIN_SAMPLE = 20;
export const HEALTH_INCIDENT_CRITICAL_USERS = 5;

export function successRate(success: number | null, failed: number | null): number | null {
  if (success == null || failed == null) return null;
  const denominator = success + failed;
  if (denominator <= 0) return null;
  return success / denominator;
}

export function failureRate(success: number | null, failed: number | null): number | null {
  const rate = successRate(success, failed);
  return rate == null ? null : 1 - rate;
}

export function isPotentialRegression(
  current: { failed: number; total: number },
  previous: { failed: number; total: number },
  minSample = HEALTH_REGRESSION_MIN_SAMPLE,
  relative = HEALTH_REGRESSION_RELATIVE,
  absolute = HEALTH_REGRESSION_ABSOLUTE,
): boolean {
  if (current.total < minSample || previous.total < minSample) return false;
  const cur = current.total > 0 ? current.failed / current.total : 0;
  const prev = previous.total > 0 ? previous.failed / previous.total : 0;
  const abs = cur - prev;
  if (abs < absolute) return false;
  if (prev <= 0) return cur >= absolute;
  return abs / prev >= relative;
}

export function classifyErrorStatus(input: {
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  from: string;
  to: string;
}): "New" | "Ongoing" | "Regressed" | "Resolved" {
  const first = input.firstSeenAt.slice(0, 10);
  const last = input.lastSeenAt.slice(0, 10);
  const resolved = input.resolvedAt?.slice(0, 10) ?? null;
  if (resolved && resolved >= input.from && resolved < input.to) return "Resolved";
  if (resolved) return "Resolved";
  if (first >= input.from && first < input.to) return "New";
  if (last >= input.from && last < input.to && first < input.from) return "Ongoing";
  return "Ongoing";
}

export type HealthTotals = {
  clipSaveSuccess: number;
  clipSaveFailed: number;
  uploadSuccess: number;
  uploadFailed: number;
  renderSuccess: number;
  renderFailed: number;
  errorEvents: number;
  criticalErrors: number;
  uniqueAffectedUsers: number;
};

export function emptyHealthTotals(): HealthTotals {
  return {
    clipSaveSuccess: 0,
    clipSaveFailed: 0,
    uploadSuccess: 0,
    uploadFailed: 0,
    renderSuccess: 0,
    renderFailed: 0,
    errorEvents: 0,
    criticalErrors: 0,
    uniqueAffectedUsers: 0,
  };
}

export function addHealthRows(rows: Array<Partial<HealthTotals>>): HealthTotals {
  return rows.reduce<HealthTotals>((sum, row) => ({
    clipSaveSuccess: sum.clipSaveSuccess + Number(row.clipSaveSuccess || 0),
    clipSaveFailed: sum.clipSaveFailed + Number(row.clipSaveFailed || 0),
    uploadSuccess: sum.uploadSuccess + Number(row.uploadSuccess || 0),
    uploadFailed: sum.uploadFailed + Number(row.uploadFailed || 0),
    renderSuccess: sum.renderSuccess + Number(row.renderSuccess || 0),
    renderFailed: sum.renderFailed + Number(row.renderFailed || 0),
    errorEvents: sum.errorEvents + Number(row.errorEvents || 0),
    criticalErrors: sum.criticalErrors + Number(row.criticalErrors || 0),
    uniqueAffectedUsers: sum.uniqueAffectedUsers + Number(row.uniqueAffectedUsers || 0),
  }), emptyHealthTotals());
}

export function healthInsights(input: {
  uploadRate: number | null;
  previousUploadRate: number | null;
  versionLabel: string | null;
  previousVersionLabel: string | null;
  saveRegression: boolean;
  newErrorGroupCount: number;
  affectedUserCount: number | null;
  newErrorLabel: string | null;
}): string[] {
  const lines: string[] = [];
  if (input.uploadRate != null && input.previousUploadRate != null && input.uploadRate !== input.previousUploadRate) {
    lines.push(
      `Upload failure rate ${input.previousUploadRate > input.uploadRate ? "decreased" : "increased"} from ${(input.previousUploadRate * 100).toFixed(1)}% to ${(input.uploadRate * 100).toFixed(1)}%.`,
    );
  }
  if (input.saveRegression && input.versionLabel && input.previousVersionLabel) {
    lines.push(
      `Replayr ${input.versionLabel} has a higher observed clip-save failure rate than ${input.previousVersionLabel}.`,
    );
  }
  if (input.newErrorGroupCount > 0) {
    const noun = input.newErrorGroupCount === 1 ? "group was" : "groups were";
    lines.push(
      input.newErrorLabel
        ? `${input.newErrorGroupCount} new error ${noun} detected: ${input.newErrorLabel}.`
        : `${input.newErrorGroupCount} new error ${noun} detected.`,
    );
  }
  if (input.affectedUserCount != null && input.affectedUserCount > 0 && input.newErrorLabel) {
    lines.push(`${input.affectedUserCount} users encountered the same new error: ${input.newErrorLabel}.`);
  }
  return lines;
}
