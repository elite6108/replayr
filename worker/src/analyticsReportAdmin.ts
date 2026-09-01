import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import { REPORT_TYPES, generateAnalyticsReport, getAnalyticsReport, listAnalyticsReports, presentReport, type ReportType } from "./analyticsReport";
import { buildReportCsv } from "./analyticsReportCsv";
import { pdfContainsForbidden, renderReportPdf } from "./analyticsReportPdf";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest } from "./shared";

export async function handleAnalyticsReports(request: Request, env: Env, url: URL, actor: { id: string; requestId: string | null }): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/admin/analytics/reports") {
    return json(await listAnalyticsReports(env, url.searchParams.get("cursor")));
  }
  if (request.method === "POST" && path === "/v1/admin/analytics/reports") {
    const body = (await request.json().catch(() => ({}))) as {
      type?: unknown;
      date?: unknown;
      from?: unknown;
      to?: unknown;
      timezone?: unknown;
    };
    const type = String(body.type || "");
    if (!REPORT_TYPES.includes(type as ReportType)) throw new HttpError(400, "type must be daily, weekly, monthly, quarterly, ytd, or custom.");
    const row = await generateAnalyticsReport(env, {
      type: type as ReportType,
      date: typeof body.date === "string" ? body.date : undefined,
      from: typeof body.from === "string" ? body.from : undefined,
      toInclusive: typeof body.to === "string" ? body.to : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      generatedBy: actor.id,
    });
    await writeAuditLog(env, {
      actorUserId: actor.id,
      actorType: "admin",
      action: AUDIT_ACTIONS.analyticsReportGenerated,
      targetType: "analytics_report",
      targetId: row.id,
      requestId: actor.requestId,
      metadata: { report_id: row.id, report_type: row.report_type, period_start: row.period_start, period_end: row.period_end },
    });
    return json(presentReport(row), 201);
  }
  const match = path.match(/^\/v1\/admin\/analytics\/reports\/([^/]+)(?:\/(regenerate|pdf|export\/([^/]+)))?$/);
  if (!match) return null;
  const id = match[1];
  const action = match[2] ?? "";
  const topic = match[3];
  if (request.method === "GET" && !action) {
    const row = await getAnalyticsReport(env, id);
    const people = row.generated_by
      ? await serviceRest<Array<{ id: string; display_name: string | null; username: string | null }>>(
          env,
          "GET",
          `/profiles?id=eq.${row.generated_by}&select=id,username,display_name`,
        ).catch(() => [])
      : [];
    return json(presentReport(row, people[0]?.display_name || people[0]?.username || "Admin"));
  }
  if (request.method === "POST" && action === "regenerate") {
    const existing = await getAnalyticsReport(env, id);
    const row = await generateAnalyticsReport(env, {
      type: existing.report_type,
      timezone: existing.display_timezone,
      generatedBy: actor.id,
      regeneratedFromId: existing.id,
      periodOverride: {
        from: existing.period_start,
        to: existing.period_end,
        label: existing.metrics_json.meta.label,
      },
    });
    await writeAuditLog(env, {
      actorUserId: actor.id,
      actorType: "admin",
      action: AUDIT_ACTIONS.analyticsReportRegenerated,
      targetType: "analytics_report",
      targetId: row.id,
      requestId: actor.requestId,
      metadata: { report_id: row.id, report_type: row.report_type, period_start: row.period_start, period_end: row.period_end },
    });
    return json(presentReport(row), 201);
  }
  if ((request.method === "GET" || request.method === "POST") && action === "pdf") {
    const row = await getAnalyticsReport(env, id);
    const bytes = renderReportPdf(row);
    if (pdfContainsForbidden(bytes)) throw new HttpError(500, "PDF refused to include sensitive content.");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="replayr-report-${row.id.slice(0, 8)}.pdf"`,
        "cache-control": "private, no-store",
      },
    });
  }
  if (request.method === "GET" && topic) {
    const row = await getAnalyticsReport(env, id);
    const file = buildReportCsv(row, topic);
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "private, no-store",
      },
    });
  }
  return null;
}

