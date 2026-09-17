import { AUDIT_ACTIONS, writeAuditLog } from "./audit";
import {
  publicSiteUrl,
  sendReplayrEmail,
  waitlistCampaignEmail,
  waitlistUnsubscribeUrl,
} from "./email";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest, serviceRestCount } from "./shared";
import type { StaffActor } from "./staffAuth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAIN_BATCH = 20;

type WaitlistRow = {
  id: string;
  email: string;
  source: string;
  created_at: string;
  confirmation_sent_at: string | null;
  unsubscribed_at: string | null;
  unsubscribe_token: string;
};

type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
};

type CampaignRow = {
  id: string;
  subject: string;
  body: string;
  talking_points: string | null;
  include_announcements: boolean;
  audience: "all" | "selected";
  status: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_at: string;
};

type PendingRecipient = {
  id: string;
  campaign_id: string;
  waitlist_id: string;
  waitlist_emails:
    | {
        email: string;
        unsubscribe_token: string;
        unsubscribed_at: string | null;
      }
    | {
        email: string;
        unsubscribe_token: string;
        unsubscribed_at: string | null;
      }[]
    | null;
};

type AnnouncementRow = { title: string; body: string | null };

export function waitlistRowIsSubscribed(row: { unsubscribed_at?: string | null }): boolean {
  return !row.unsubscribed_at;
}

export async function handleWaitlistAdmin(
  request: Request,
  env: Env,
  url: URL,
  actor: StaffActor,
  ctx?: { waitUntil(task: Promise<unknown>): void },
): Promise<Response | null> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/admin/waitlist") {
    return listWaitlist(env, url);
  }
  if (request.method === "GET" && path === "/v1/admin/waitlist/templates") {
    return listTemplates(env);
  }
  if (request.method === "POST" && path === "/v1/admin/waitlist/templates") {
    return createTemplate(request, env, actor);
  }
  const templateItem = path.match(/^\/v1\/admin\/waitlist\/templates\/([^/]+)$/);
  if (templateItem?.[1] && request.method === "DELETE") {
    return deleteTemplate(env, templateItem[1]);
  }
  if (request.method === "POST" && path === "/v1/admin/waitlist/rewrite") {
    return rewriteCampaign(request, env);
  }
  if (request.method === "GET" && path === "/v1/admin/waitlist/campaigns") {
    return listCampaigns(env);
  }
  if (request.method === "POST" && path === "/v1/admin/waitlist/campaigns") {
    return queueCampaign(request, env, actor, ctx);
  }
  if (!path.startsWith("/v1/admin/waitlist")) return null;
  throw new HttpError(404, "Not found.");
}

async function listWaitlist(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50));
  const from = (page - 1) * limit;
  const safe = q.replace(/[^a-z0-9.@_+-]/g, "");
  const filter = safe ? `&email=ilike.*${encodeURIComponent(safe)}*` : "";
  const [rows, total] = await Promise.all([
    serviceRest<WaitlistRow[]>(
      env,
      "GET",
      `/waitlist_emails?select=id,email,source,created_at,confirmation_sent_at,unsubscribed_at&order=created_at.desc${filter}&limit=${limit}&offset=${from}`,
    ),
    serviceRestCount(env, `/waitlist_emails?select=id${filter}`),
  ]);
  return json({
    items: rows.map((row) => ({
      id: row.id,
      email: row.email,
      source: row.source,
      createdAt: row.created_at,
      confirmationSentAt: row.confirmation_sent_at,
      unsubscribedAt: row.unsubscribed_at,
    })),
    total,
    page,
    limit,
    aiEnabled: Boolean(env.OPENAI_API_KEY),
    updates: await loadWaitlistUpdates(env).catch(() => ({ announcements: [], releases: [] })),
  });
}

async function listTemplates(env: Env): Promise<Response> {
  const rows = await serviceRest<TemplateRow[]>(
    env,
    "GET",
    "/waitlist_email_templates?select=id,name,subject,body,created_at,updated_at&order=updated_at.desc",
  );
  return json({
    templates: rows.map((row) => ({
      id: row.id,
      name: row.name,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
}

async function createTemplate(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; subject?: unknown; body?: unknown };
  const name = String(body.name ?? "").trim().slice(0, 80);
  const subject = String(body.subject ?? "").trim().slice(0, 160);
  const text = String(body.body ?? "").trim().slice(0, 8000);
  if (!name || !subject || !text) throw new HttpError(400, "Name, subject, and body are required.");
  const rows = await serviceRest<TemplateRow[]>(
    env,
    "POST",
    "/waitlist_email_templates",
    { name, subject, body: text, created_by: actor.userId },
    "return=representation",
  );
  const row = rows[0];
  if (!row) throw new HttpError(502, "Could not save that template.");
  return json({
    template: {
      id: row.id,
      name: row.name,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
}

async function deleteTemplate(env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) throw new HttpError(400, "Invalid template.");
  await serviceRest(env, "DELETE", `/waitlist_email_templates?id=eq.${id}`, undefined, "return=minimal");
  return json({ ok: true });
}

async function listCampaigns(env: Env): Promise<Response> {
  const rows = await serviceRest<CampaignRow[]>(
    env,
    "GET",
    "/waitlist_campaigns?select=id,subject,body,talking_points,include_announcements,audience,status,recipient_count,sent_count,failed_count,skipped_count,created_at&order=created_at.desc&limit=20",
  );
  return json({
    campaigns: rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      audience: row.audience,
      status: row.status,
      recipientCount: row.recipient_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      skippedCount: row.skipped_count,
      createdAt: row.created_at,
    })),
  });
}

async function rewriteCampaign(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    subject?: unknown;
    body?: unknown;
    goal?: unknown;
    talkingPoints?: unknown;
    includeUpdates?: unknown;
    includeAnnouncements?: unknown;
  };
  const draft = await rewriteWaitlistCopy(env, {
    subject: String(body.subject ?? ""),
    body: String(body.body ?? ""),
    goal: String(body.goal ?? ""),
    talkingPoints: String(body.talkingPoints ?? ""),
    includeUpdates: body.includeUpdates !== false && body.includeAnnouncements !== false,
  });
  return json(draft);
}

export function newestReleases(raw: unknown, limit = 3): Array<{ version: string; items: string[] }> {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([version, value]) => ({
      version,
      items: Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : typeof value === "string" && value.trim()
          ? [value.trim()]
          : [],
    }))
    .filter((entry) => entry.items.length)
    .sort((a, b) => compareVersion(b.version, a.version))
    .slice(0, limit);
}

function compareVersion(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function formatWaitlistUpdates(updates: {
  announcements: Array<{ title: string; body: string | null }>;
  releases: Array<{ version: string; items: string[] }>;
}): string {
  const parts: string[] = [];
  if (updates.releases.length) {
    parts.push("Shipped desktop releases (newest first):");
    for (const release of updates.releases) {
      parts.push(`v${release.version}`);
      for (const item of release.items) parts.push(`- ${item}`);
    }
  }
  if (updates.announcements.length) {
    if (parts.length) parts.push("");
    parts.push("In-app announcements:");
    for (const row of updates.announcements) {
      parts.push(`- ${row.title}${row.body ? `: ${row.body.slice(0, 280)}` : ""}`);
    }
  }
  return parts.join("\n");
}

export function buildWaitlistAiUserPrompt(input: {
  subject: string;
  body: string;
  goal: string;
  talkingPoints: string;
  updates: string;
}): string {
  return [
    input.goal.trim() ? `Operator brief (what this email should do):\n${input.goal.trim()}` : "",
    input.talkingPoints.trim() ? `Extra facts from the operator:\n${input.talkingPoints.trim()}` : "",
    input.updates.trim() ? `Newest Replayr updates (use only what fits the brief; do not dump the whole list):\n${input.updates.trim()}` : "",
    input.subject.trim() ? `Current subject: ${input.subject.trim()}` : "",
    input.body.trim()
      ? `Current draft:\n${input.body.trim()}`
      : "Write a new waitlist email from the brief and the newest updates.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function loadWaitlistUpdates(env: Env): Promise<{
  announcements: Array<{ title: string; body: string | null }>;
  releases: Array<{ version: string; items: string[] }>;
}> {
  const [announcements, releases] = await Promise.all([
    serviceRest<AnnouncementRow[]>(
      env,
      "GET",
      "/announcements?select=title,body&enabled=eq.true&order=starts_at.desc&limit=5",
    ).catch(() => [] as AnnouncementRow[]),
    loadReleaseNotes(env),
  ]);
  return {
    announcements: announcements.map((row) => ({ title: row.title, body: row.body })),
    releases,
  };
}

async function loadReleaseNotes(env: Env): Promise<Array<{ version: string; items: string[] }>> {
  const urls: string[] = [];
  const origin = publicSiteUrl(env.PUBLIC_APP_URL).replace(/\/$/, "");
  urls.push(`${origin}/releases/release-notes.json`);
  if (origin.includes("127.0.0.1") || origin.includes("localhost")) {
    urls.push("http://127.0.0.1:5174/releases/release-notes.json");
  }
  if (env.ASSETS) {
    try {
      const asset = await env.ASSETS.fetch(new Request("https://replayr.tv/releases/release-notes.json"));
      if (asset.ok) return newestReleases(await asset.json());
    } catch {
      /* fall through */
    }
  }
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) return newestReleases(await response.json());
    } catch {
      /* try next */
    }
  }
  return [];
}

export async function rewriteWaitlistCopy(
  env: Env,
  input: {
    subject: string;
    body: string;
    goal?: string;
    talkingPoints: string;
    includeUpdates: boolean;
  },
): Promise<{ subject: string; body: string }> {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError(503, "Add OPENAI_API_KEY to the Worker to enable AI drafts.");
  }
  const goal = String(input.goal ?? "").trim();
  const updates = input.includeUpdates ? await loadWaitlistUpdates(env) : { announcements: [], releases: [] };
  const updatesText = formatWaitlistUpdates(updates);
  const user = buildWaitlistAiUserPrompt({
    subject: input.subject,
    body: input.body,
    goal,
    talkingPoints: input.talkingPoints,
    updates: updatesText,
  });
  if (!goal && !input.talkingPoints.trim() && !input.body.trim() && !input.subject.trim() && !updatesText) {
    throw new HttpError(400, "Add a brief, extra facts, or wait until updates are available.");
  }

  const writingNew = !input.body.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: writingNew
              ? "You write short Replayr waitlist emails. Replayr is a Windows Instant Replay clipper: local-first gameplay clips, share when ready. Follow the operator brief for tone, length, and which updates to highlight. Return JSON {\"subject\":\"...\",\"body\":\"...\"}. Subject under 70 characters. Body is plain text, 80-160 words unless the brief asks otherwise, energetic but not spammy. Mention replayr.tv and @Replayr_TV in the body. Do not invent metrics, dates, or features that are not in the brief, extra facts, or newest updates."
              : "You rewrite Replayr waitlist emails. Keep the operator's facts. Replayr is a Windows Instant Replay clipper: local-first gameplay clips, share when ready. Follow the operator brief. Return JSON {\"subject\":\"...\",\"body\":\"...\"}. Subject under 70 characters. Body is plain text, 80-160 words unless the brief asks otherwise. Mention replayr.tv and @Replayr_TV in the body. Do not invent metrics, dates, or features that are not in the brief, extra facts, newest updates, or current draft.",
          },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new HttpError(502, payload.error?.message || "AI rewrite failed.");
    }
    const parsed = parseRewriteJson(payload.choices?.[0]?.message?.content || "");
    if (!parsed) throw new HttpError(502, "AI rewrite returned unusable copy.");
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseRewriteJson(raw: string): { subject: string; body: string } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as { subject?: unknown; body?: unknown };
    const subject = String(value.subject ?? "").trim().slice(0, 160);
    const body = String(value.body ?? "").trim().slice(0, 8000);
    if (!subject || !body) return null;
    return { subject, body };
  } catch {
    return null;
  }
}

async function queueCampaign(
  request: Request,
  env: Env,
  actor: StaffActor,
  ctx?: { waitUntil(task: Promise<unknown>): void },
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    subject?: unknown;
    body?: unknown;
    goal?: unknown;
    talkingPoints?: unknown;
    includeUpdates?: unknown;
    includeAnnouncements?: unknown;
    audience?: unknown;
    ids?: unknown;
    saveAsTemplate?: unknown;
    templateName?: unknown;
  };
  const subject = String(body.subject ?? "").trim().slice(0, 160);
  const text = String(body.body ?? "").trim().slice(0, 8000);
  const audience = body.audience === "selected" ? "selected" : "all";
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter((id) => UUID.test(id)) : [];
  if (!subject || !text) throw new HttpError(400, "Subject and body are required.");
  if (audience === "selected" && !ids.length) throw new HttpError(400, "Select at least one subscriber.");

  const recipients = await loadCampaignRecipients(env, audience, ids);
  if (!recipients.length) throw new HttpError(400, "No subscribed waitlist emails match.");

  if (body.saveAsTemplate) {
    const name = String(body.templateName ?? subject).trim().slice(0, 80) || subject;
    await serviceRest(
      env,
      "POST",
      "/waitlist_email_templates",
      { name, subject, body: text, created_by: actor.userId },
      "return=minimal",
    ).catch(() => undefined);
  }

  const campaigns = await serviceRest<CampaignRow[]>(
    env,
    "POST",
    "/waitlist_campaigns",
    {
      subject,
      body: text,
      talking_points:
        [String(body.goal ?? "").trim() && `Brief: ${String(body.goal).trim()}`, String(body.talkingPoints ?? "").trim()]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 2000) || null,
      include_announcements: body.includeUpdates !== false && body.includeAnnouncements !== false,
      audience,
      status: "queued",
      created_by: actor.userId,
      recipient_count: recipients.length,
    },
    "return=representation",
  );
  const campaign = campaigns[0];
  if (!campaign) throw new HttpError(502, "Could not queue that campaign.");

  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100).map((row) => ({
      campaign_id: campaign.id,
      waitlist_id: row.id,
      status: "pending",
    }));
    await serviceRest(env, "POST", "/waitlist_campaign_recipients", chunk, "return=minimal");
  }

  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.waitlistCampaignQueued,
    targetType: "waitlist_campaign",
    targetId: campaign.id,
    metadata: { audience, recipientCount: recipients.length, subject },
    requestId: actor.requestId,
  });

  const drain = drainWaitlistCampaigns(env);
  if (ctx?.waitUntil) ctx.waitUntil(drain);
  else await drain;

  return json({
    campaign: {
      id: campaign.id,
      subject: campaign.subject,
      audience: campaign.audience,
      status: "queued",
      recipientCount: recipients.length,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
    },
  });
}

export async function loadCampaignRecipients(
  env: Env,
  audience: "all" | "selected",
  ids: string[],
): Promise<Array<{ id: string; email: string }>> {
  if (audience === "selected") {
    const unique = [...new Set(ids)];
    const rows = await serviceRest<WaitlistRow[]>(
      env,
      "GET",
      `/waitlist_emails?id=in.(${unique.join(",")})&select=id,email,unsubscribed_at`,
    );
    return rows.filter(waitlistRowIsSubscribed).map((row) => ({ id: row.id, email: row.email }));
  }
  const rows = await serviceRest<WaitlistRow[]>(
    env,
    "GET",
    "/waitlist_emails?unsubscribed_at=is.null&select=id,email,unsubscribed_at&order=created_at.desc",
  );
  return rows.map((row) => ({ id: row.id, email: row.email }));
}

export async function drainWaitlistCampaigns(env: Env, send = sendReplayrEmail): Promise<{ processed: number }> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { processed: 0 };
  const origin = publicSiteUrl(env.PUBLIC_APP_URL);
  let processed = 0;
  const pending = await serviceRest<PendingRecipient[]>(
    env,
    "GET",
    `/waitlist_campaign_recipients?status=eq.pending&select=id,campaign_id,waitlist_id,waitlist_emails(email,unsubscribe_token,unsubscribed_at)&order=created_at.asc&limit=${DRAIN_BATCH}`,
  );
  if (!pending.length) return { processed: 0 };

  const campaignIds = [...new Set(pending.map((row) => row.campaign_id))];
  const campaigns = await serviceRest<CampaignRow[]>(
    env,
    "GET",
    `/waitlist_campaigns?id=in.(${campaignIds.join(",")})&select=id,subject,body,status,recipient_count,sent_count,failed_count,skipped_count`,
  );
  const campaignById = new Map(campaigns.map((row) => [row.id, row]));

  for (const row of pending) {
    const campaign = campaignById.get(row.campaign_id);
    const subscriber = Array.isArray(row.waitlist_emails) ? row.waitlist_emails[0] : row.waitlist_emails;
    if (!campaign || !subscriber) {
      await markRecipient(env, row.id, "failed", null, "Missing campaign or subscriber.");
      processed += 1;
      continue;
    }
    if (campaign.status === "queued") {
      await serviceRest(env, "PATCH", `/waitlist_campaigns?id=eq.${campaign.id}`, { status: "sending" }, "return=minimal");
      campaign.status = "sending";
    }
    if (subscriber.unsubscribed_at) {
      await markRecipient(env, row.id, "skipped", null, "unsubscribed");
      campaign.skipped_count += 1;
      processed += 1;
      continue;
    }
    const message = waitlistCampaignEmail({
      subject: campaign.subject,
      body: campaign.body,
      siteUrl: origin,
      unsubscribeUrl: waitlistUnsubscribeUrl(origin, subscriber.unsubscribe_token),
    });
    const delivery = await send(env, {
      to: subscriber.email,
      ...message,
      idempotencyKey: `waitlist-campaign/${campaign.id}/${row.waitlist_id}`,
    });
    if (delivery.sent) {
      await markRecipient(env, row.id, "sent", delivery.providerId ?? null, null);
      campaign.sent_count += 1;
    } else {
      await markRecipient(env, row.id, "failed", null, delivery.warning || "send failed");
      campaign.failed_count += 1;
    }
    processed += 1;
  }

  for (const campaign of campaignById.values()) {
    const leftover = await serviceRestCount(
      env,
      `/waitlist_campaign_recipients?campaign_id=eq.${campaign.id}&status=eq.pending&select=id`,
    );
    const status = leftover > 0 ? "sending" : campaign.failed_count && campaign.sent_count ? "partial" : campaign.failed_count ? "failed" : "sent";
    await serviceRest(
      env,
      "PATCH",
      `/waitlist_campaigns?id=eq.${campaign.id}`,
      {
        status,
        sent_count: campaign.sent_count,
        failed_count: campaign.failed_count,
        skipped_count: campaign.skipped_count,
        completed_at: leftover > 0 ? null : new Date().toISOString(),
      },
      "return=minimal",
    );
  }
  return { processed };
}

async function markRecipient(
  env: Env,
  id: string,
  status: "sent" | "skipped" | "failed",
  providerId: string | null,
  error: string | null,
): Promise<void> {
  await serviceRest(
    env,
    "PATCH",
    `/waitlist_campaign_recipients?id=eq.${id}`,
    {
      status,
      provider_id: providerId,
      error,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    },
    "return=minimal",
  );
}
