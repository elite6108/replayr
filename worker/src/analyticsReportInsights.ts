import type { MetricAvailability } from "./analyticsAvailability";

export const REPORT_INSIGHT_MIN_SAMPLE = 10;

export type ReportKpi = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  percentageChange: number | "new" | null;
  availability: MetricAvailability | string;
  unit?: string | null;
  badge?: "proxy" | "estimate" | "incomplete" | null;
  tooltip?: string;
};

export type ReportInsight = {
  text: string;
  metricIds: string[];
  severity: "info" | "positive" | "negative" | "warning";
  confidence: "high" | "medium" | "low";
};

export type ReportRecommendation = {
  title: string;
  category: "Growth" | "Marketing" | "Product" | "Reliability" | "Infrastructure";
  text: string;
  confidence: "high" | "medium" | "low";
  basedOn: string[];
  priority: "high" | "medium" | "low";
};

function kpi(list: ReportKpi[], key: string): ReportKpi | undefined {
  return list.find((item) => item.key === key);
}

function trendable(item: ReportKpi | undefined): item is ReportKpi & { value: number; previous: number } {
  if (!item || item.value == null || item.previous == null) return false;
  if (item.availability === "NOT_INSTRUMENTED" || item.availability === "INCOMPLETE") return false;
  return true;
}

function pctLabel(change: number): string {
  return `${Math.abs(change * 100).toFixed(1)}%`;
}

export function insightFromGroupCount(count: number, label?: string | null): ReportInsight | null {
  if (count <= 0) return null;
  return {
    text: label
      ? `${count} new error groups were detected: ${label}.`
      : `${count} new error groups were detected.`,
    metricIds: ["new_error_groups"],
    severity: "warning",
    confidence: "high",
  };
}

export function buildReportInsights(input: {
  kpis: ReportKpi[];
  comparisonAvailable: boolean;
  comparisonComplete: boolean;
  newErrorGroupCount: number;
  newErrorLabel: string | null;
  affectedUserCount: number;
  topGame: { name: string; share: number; clips: number } | null;
  regressions: string[];
  folderRetentionNote: string | null;
}): ReportInsight[] {
  const out: ReportInsight[] = [];
  const installers = kpi(input.kpis, "installer_downloads");
  if (input.comparisonComplete && trendable(installers) && installers.percentageChange !== "new" && installers.percentageChange != null && installers.percentageChange !== 0) {
    const direction = installers.percentageChange >= 0 ? "increased" : "decreased";
    out.push({
      text: `Installer downloads ${direction} ${pctLabel(installers.percentageChange)} compared with the previous tracked period.`,
      metricIds: ["installer_downloads"],
      severity: installers.percentageChange >= 0 ? "positive" : "negative",
      confidence: "high",
    });
  }
  const newUsers = kpi(input.kpis, "new_users");
  if (input.comparisonComplete && trendable(newUsers) && newUsers.percentageChange !== "new" && newUsers.percentageChange != null && newUsers.percentageChange !== 0) {
    out.push({
      text: `New users ${newUsers.percentageChange >= 0 ? "increased" : "decreased"} ${pctLabel(newUsers.percentageChange)} versus the previous tracked period.`,
      metricIds: ["new_users"],
      severity: newUsers.percentageChange >= 0 ? "positive" : "negative",
      confidence: "high",
    });
  }
  const activation = kpi(input.kpis, "activation_rate_7d");
  if (activation && activation.value == null && activation.availability === "INCOMPLETE") {
    out.push({
      text: "7-day activation remains incomplete because local clip-save instrumentation coverage is still limited.",
      metricIds: ["activation_rate_7d"],
      severity: "info",
      confidence: "high",
    });
  }
  if (input.topGame && input.topGame.clips >= REPORT_INSIGHT_MIN_SAMPLE) {
    out.push({
      text: `${input.topGame.name} represented ${Math.round(input.topGame.share * 100)}% of ready cloud clips.`,
      metricIds: ["ready_cloud_clips"],
      severity: "info",
      confidence: "high",
    });
  }
  const groups = insightFromGroupCount(input.newErrorGroupCount, input.newErrorLabel);
  if (groups) out.push(groups);
  if (input.affectedUserCount > 0) {
    out.push({
      text: `${input.affectedUserCount} sampled users were affected by grouped errors.`,
      metricIds: ["unique_affected_users"],
      severity: "warning",
      confidence: "medium",
    });
  }
  for (const version of input.regressions) {
    out.push({
      text: `Replayr ${version} has a potential regression flag under the sample-size rules.`,
      metricIds: ["health_version_comparison"],
      severity: "warning",
      confidence: "medium",
    });
  }
  if (input.folderRetentionNote) {
    out.push({
      text: input.folderRetentionNote,
      metricIds: ["folder_adoption"],
      severity: "info",
      confidence: "low",
    });
  }
  if (!input.comparisonAvailable) {
    out.push({
      text: "Previous-period comparison is unavailable because that window has no tracked analytics data.",
      metricIds: ["health_version_comparison"],
      severity: "info",
      confidence: "high",
    });
  }
  return out;
}

export function buildReportRecommendations(input: {
  kpis: ReportKpi[];
  insights: ReportInsight[];
  regressions: string[];
  storageAddedBytes: number | null;
  attention: string[];
}): ReportRecommendation[] {
  const out: ReportRecommendation[] = [];
  const installers = kpi(input.kpis, "installer_downloads");
  const activated = kpi(input.kpis, "activated_users");
  if ((installers?.value ?? 0) > 0 && (activated?.value == null || activated.availability === "INCOMPLETE")) {
    out.push({
      title: "Close the download-to-first-clip gap",
      category: "Growth",
      text: "Activation is weaker than download growth. Prioritize first-launch → first-clip onboarding.",
      confidence: "medium",
      basedOn: ["installer_downloads", "activated_users"],
      priority: "medium",
    });
  }
  if (input.regressions.length) {
    out.push({
      title: "Investigate release health before wider rollout",
      category: "Reliability",
      text: `Latest version shows a material health regression flag (${input.regressions.join(", ")}). Investigate before wider rollout.`,
      confidence: "medium",
      basedOn: ["health_version_comparison"],
      priority: "high",
    });
  }
  if (input.storageAddedBytes != null && input.storageAddedBytes > 0) {
    const gib = input.storageAddedBytes / (1024 ** 3);
    out.push({
      title: "Watch cloud storage growth",
      category: "Infrastructure",
      text: `Storage added ${gib.toFixed(2)} GiB in this period. Review free-tier limits against the 30/90-day projections.`,
      confidence: "medium",
      basedOn: ["storage_bytes_added"],
      priority: gib >= 5 ? "medium" : "low",
    });
  }
  const upload = kpi(input.kpis, "upload_success_rate");
  if (upload && upload.value != null && upload.value < 0.95 && upload.availability === "AVAILABLE") {
    out.push({
      title: "Stabilize cloud uploads",
      category: "Reliability",
      text: "Upload success is below 95% for the selected period. Investigate terminal upload failures before they become a support load.",
      confidence: "high",
      basedOn: ["upload_success_rate"],
      priority: "high",
    });
  }
  return out;
}

export function buildNeedsAttention(input: { attention: string[]; insights: ReportInsight[]; recommendations: ReportRecommendation[] }): string[] {
  const items = [
    ...input.attention,
    ...input.insights.filter((item) => item.severity === "warning").map((item) => item.text),
    ...input.recommendations.filter((item) => item.priority === "high").map((item) => item.text),
  ];
  const unique = [...new Set(items.filter(Boolean))];
  return unique.length ? unique : ["No major issues detected in tracked data."];
}

export function buildExecutiveSummary(input: {
  label: string;
  kpis: ReportKpi[];
  insights: ReportInsight[];
  comparisonAvailable: boolean;
  comparisonComplete: boolean;
}): string {
  const sentences: string[] = [];
  const installers = kpi(input.kpis, "installer_downloads");
  const newUsers = kpi(input.kpis, "new_users");
  const errors = kpi(input.kpis, "error_events");
  const mrr = kpi(input.kpis, "estimated_mrr_cents");
  if (newUsers?.value != null) {
    sentences.push(`${input.label} recorded ${newUsers.value} new users.`);
  }
  const installerInsight = input.insights.find((item) => item.metricIds.includes("installer_downloads"));
  if (installerInsight) sentences.push(installerInsight.text);
  else if (installers?.value != null) {
    sentences.push(`Installer downloads were ${installers.value} in the selected period.`);
  }
  const activation = input.insights.find((item) => item.metricIds.includes("activation_rate_7d"));
  if (activation) sentences.push(activation.text);
  if (mrr?.value != null && mrr.availability === "AVAILABLE_ESTIMATE") {
    sentences.push(`Estimated MRR was $${(mrr.value / 100).toFixed(2)} (estimate, not revenue).`);
  }
  if (errors?.value != null) {
    sentences.push(`${errors.value} error events occurred in the period.`);
  }
  if (!input.comparisonAvailable) {
    sentences.push("No tracked data exists for the previous period, so period-over-period movement is unavailable.");
  } else if (!input.comparisonComplete) {
    sentences.push("The previous period only partially overlaps tracked data, so period-sum comparisons were not used.");
  }
  const health = input.insights.find((item) => item.metricIds.includes("new_error_groups") || item.metricIds.includes("health_version_comparison"));
  if (health) sentences.push(health.text);
  if (!sentences.length) {
    return `Replayr analytics for ${input.label} are available only for metrics that were instrumented in this window. Several product surfaces remain incomplete or not instrumented.`;
  }
  return sentences.join(" ");
}

export function buildCoverageNotes(input: {
  firstDay: string;
  downloadsFrom: string;
  activityFrom: string;
}): Array<{ key: string; label: string; status: string; note: string }> {
  return [
    { key: "analytics_start", label: "Analytics tracking began", status: "AVAILABLE", note: input.firstDay },
    { key: "downloads_start", label: "Download tracking began", status: "AVAILABLE", note: input.downloadsFrom },
    { key: "dau_start", label: "DAU tracking began", status: "INCOMPLETE", note: input.activityFrom },
    { key: "desktop_saves", label: "Desktop save/filter analytics", status: "INCOMPLETE", note: "Available from desktop builds that emit clip.saved / clip.save_failed." },
    { key: "retention_d30", label: "D30 retention", status: "INCOMPLETE", note: "Not mature until 30 tracked days after a cohort start." },
    { key: "bandwidth_cost", label: "Bandwidth", status: "NOT_INSTRUMENTED", note: "No R2 or Bunny bandwidth feed." },
    { key: "estimated_mrr_cents", label: "MRR", status: "AVAILABLE_ESTIMATE", note: "Estimated only. Not revenue. Authoritative cents stay null without paid Stripe amounts." },
  ];
}
