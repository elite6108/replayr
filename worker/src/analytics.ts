import { captureAnonymousFromEvent, handleAnalyticsIdentify } from "./analyticsAcquisition";
import {
  ANALYTICS_ENVIRONMENTS,
  ANALYTICS_PLATFORMS,
  isServerAuthoritativeEvent,
  SERVER_ANALYTICS_EVENTS,
  serverIdempotencyKey,
  type AnalyticsEnvironment,
} from "./analyticsDictionary";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { assertRateLimit } from "./rateLimit";
import { optionalUser } from "./shared";

export { METRIC_DEFINITIONS, SERVER_ANALYTICS_EVENTS, serverIdempotencyKey } from "./analyticsDictionary";

export const ANALYTICS_MAX_PROPERTIES_BYTES = 4096;
export const ANALYTICS_MAX_EVENTS_PER_REQUEST = 20;
export const ANALYTICS_ANON_LIMIT = 30;
export const ANALYTICS_AUTH_LIMIT = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SHORT = 80;
const MEDIUM = 160;

const BLOCKED_PROPERTY_KEYS = new Set([
  "password",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "secret",
  "api_key",
  "apikey",
  "service_role",
  "private_key",
]);

export type AnalyticsEventInput = {
  id?: string;
  idempotencyKey?: string;
  anonymousId?: string;
  sessionId?: string;
  eventName: string;
  eventVersion?: number;
  platform?: string;
  appVersion?: string;
  os?: string;
  deviceType?: string;
  environment?: string;
  properties?: Record<string, unknown>;
  acquisitionSource?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  occurredAt?: string;
};

export type AnalyticsRow = {
  id: string | null;
  idempotency_key: string | null;
  user_id: string | null;
  anonymous_id: string | null;
  session_id: string | null;
  event_name: string;
  event_version: number;
  platform: string | null;
  app_version: string | null;
  os: string | null;
  device_type: string | null;
  environment: AnalyticsEnvironment;
  properties: Record<string, unknown>;
  acquisition_source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  country_code: string | null;
  occurred_at: string;
};

export function resolveAnalyticsEnvironment(env: Env, explicit?: string | null): AnalyticsEnvironment {
  if (explicit === "production" || explicit === "development") return explicit;
  try {
    const host = new URL(env.PUBLIC_APP_URL || "https://www.replayr.tv").hostname;
    if (host === "localhost" || host === "127.0.0.1") return "development";
  } catch {
    /* keep production */
  }
  return "production";
}

export function sanitizeAnalyticsProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "properties must be an object.");
  }
  if (JSON.stringify(value).length > ANALYTICS_MAX_PROPERTIES_BYTES) {
    throw new HttpError(400, "Event properties are too large.");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > 24) throw new HttpError(400, "Too many event properties.");
  const next: Record<string, unknown> = {};
  for (const key of keys) {
    if (BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    const item = input[key];
    if (item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      if (typeof item === "string" && item.length > 200) {
        next[key] = item.slice(0, 200);
      } else {
        next[key] = item;
      }
    }
  }
  const encoded = JSON.stringify(next);
  if (encoded.length > ANALYTICS_MAX_PROPERTIES_BYTES) {
    throw new HttpError(400, "Event properties are too large.");
  }
  return next;
}

export function parseClientAnalyticsEvents(body: unknown): AnalyticsEventInput[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Send a JSON event or { events: [...] }.");
  }
  const raw = body as Record<string, unknown>;
  const list = Array.isArray(raw.events) ? raw.events : raw.eventName ? [raw] : null;
  if (!list) throw new HttpError(400, "eventName is required.");
  if (list.length === 0) throw new HttpError(400, "Send at least one event.");
  if (list.length > ANALYTICS_MAX_EVENTS_PER_REQUEST) {
    throw new HttpError(400, `Send at most ${ANALYTICS_MAX_EVENTS_PER_REQUEST} events.`);
  }
  return list.map((item, index) => parseOneClientEvent(item, index));
}

function parseOneClientEvent(value: unknown, index: number): AnalyticsEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `Event ${index + 1} is invalid.`);
  }
  const raw = value as Record<string, unknown>;
  const eventName = asTrimmed(raw.eventName ?? raw.event_name);
  if (!eventName || !EVENT_NAME.test(eventName) || eventName.length > SHORT) {
    throw new HttpError(400, "eventName is invalid.");
  }
  if (isServerAuthoritativeEvent(eventName)) {
    throw new HttpError(403, "That event can only be recorded by Replayr servers.");
  }
  if (raw.environment != null && !ANALYTICS_ENVIRONMENTS.includes(raw.environment as AnalyticsEnvironment)) {
    throw new HttpError(400, "environment must be production or development.");
  }
  const eventVersion = raw.eventVersion ?? raw.event_version;
  if (eventVersion != null && (!Number.isInteger(eventVersion) || Number(eventVersion) < 1)) {
    throw new HttpError(400, "eventVersion must be a positive integer.");
  }
  if (raw.platform != null && !ANALYTICS_PLATFORMS.includes(raw.platform as (typeof ANALYTICS_PLATFORMS)[number])) {
    throw new HttpError(400, "platform is invalid.");
  }
  if (raw.idempotencyKey && isReservedIdempotencyKey(String(raw.idempotencyKey))) {
    throw new HttpError(403, "That idempotency key is reserved.");
  }
  return {
    id: optionalUuid(raw.id),
    idempotencyKey: optionalText(raw.idempotencyKey ?? raw.idempotency_key, MEDIUM),
    anonymousId: optionalText(raw.anonymousId ?? raw.anonymous_id, MEDIUM),
    sessionId: optionalText(raw.sessionId ?? raw.session_id, MEDIUM),
    eventName,
    eventVersion: eventVersion == null ? 1 : Number(eventVersion),
    platform: optionalText(raw.platform, 24),
    appVersion: optionalText(raw.appVersion ?? raw.app_version, 40),
    os: optionalText(raw.os, 40),
    deviceType: optionalText(raw.deviceType ?? raw.device_type, 40),
    environment: optionalText(raw.environment, 24),
    properties: raw.properties === undefined ? {} : sanitizeAnalyticsProperties(raw.properties),
    acquisitionSource: optionalText(raw.acquisitionSource ?? raw.acquisition_source, SHORT),
    utmSource: optionalText(raw.utmSource ?? raw.utm_source, SHORT),
    utmMedium: optionalText(raw.utmMedium ?? raw.utm_medium, SHORT),
    utmCampaign: optionalText(raw.utmCampaign ?? raw.utm_campaign, SHORT),
    utmContent: optionalText(raw.utmContent ?? raw.utm_content, SHORT),
    utmTerm: optionalText(raw.utmTerm ?? raw.utm_term, SHORT),
    occurredAt: optionalIso(raw.occurredAt ?? raw.occurred_at),
  };
}

export function toAnalyticsRow(
  event: AnalyticsEventInput,
  extras: {
    userId?: string | null;
    environment: AnalyticsEnvironment;
    countryCode?: string | null;
  },
): AnalyticsRow {
  return {
    id: event.id ?? null,
    idempotency_key: event.idempotencyKey ?? null,
    user_id: extras.userId ?? null,
    anonymous_id: event.anonymousId ?? null,
    session_id: event.sessionId ?? null,
    event_name: event.eventName,
    event_version: event.eventVersion ?? 1,
    platform: event.platform ?? null,
    app_version: event.appVersion ?? null,
    os: event.os ?? null,
    device_type: event.deviceType ?? null,
    environment: extras.environment,
    properties: event.properties ?? {},
    acquisition_source: event.acquisitionSource ?? null,
    utm_source: event.utmSource ?? null,
    utm_medium: event.utmMedium ?? null,
    utm_campaign: event.utmCampaign ?? null,
    utm_content: event.utmContent ?? null,
    utm_term: event.utmTerm ?? null,
    country_code: extras.countryCode ?? null,
    occurred_at: event.occurredAt ?? new Date().toISOString(),
  };
}

export function coarseCountry(request: Request): string | null {
  const raw = (request.headers.get("cf-ipcountry") || "").trim().toUpperCase();
  if (raw.length === 2 && raw !== "XX" && raw !== "T1") return raw;
  return null;
}

export async function handleAnalytics(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/v1/analytics/events" && request.method === "POST") {
    return ingestClientAnalytics(request, env);
  }
  if (url.pathname === "/v1/analytics/identify" && request.method === "POST") {
    return handleAnalyticsIdentify(request, env);
  }
  return null;
}

export async function ingestClientAnalytics(request: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Analytics ingest is not configured.");
  }
  const user = await optionalUser(request, env);
  assertRateLimit(request, "analytics", user ? ANALYTICS_AUTH_LIMIT : ANALYTICS_ANON_LIMIT, user?.id);
  const payload = (await request.json().catch(() => null)) as unknown;
  const events = parseClientAnalyticsEvents(payload);
  const environmentDefault = resolveAnalyticsEnvironment(env);
  const country = coarseCountry(request);
  let accepted = 0;
  let duplicates = 0;
  for (const event of events) {
    const row = toAnalyticsRow(event, {
      userId: user?.id ?? null,
      environment: resolveAnalyticsEnvironment(env, event.environment) || environmentDefault,
      countryCode: country,
    });
    const result = await insertAnalyticsEvent(env, row);
    if (result.inserted) accepted += 1;
    else duplicates += 1;
    if (row.anonymous_id) {
      captureAnonymousFromEvent(env, {
        anonymousId: row.anonymous_id,
        source: row.utm_source,
        medium: row.utm_medium,
        campaign: row.utm_campaign,
        content: row.utm_content,
        term: row.utm_term,
      });
    }
  }
  return json({ ok: true, accepted, duplicates }, 202);
}

export function observeCountedAnalytics(
  env: Env,
  eventName: string,
  input: {
    userId?: string | null;
    anonymousId?: string | null;
    properties?: Record<string, unknown>;
    platform?: string;
    occurredAt?: string;
  } = {},
): void {
  try {
    const row = toAnalyticsRow(
      {
        eventName,
        anonymousId: input.anonymousId ?? undefined,
        platform: input.platform ?? "server",
        properties: input.properties ?? {},
        occurredAt: input.occurredAt,
      },
      {
        userId: input.userId ?? null,
        environment: resolveAnalyticsEnvironment(env),
      },
    );
    void insertAnalyticsEvent(env, row).catch(() => undefined);
  } catch {
    /* observational */
  }
}

export function observeServerAnalytics(
  env: Env,
  eventName: (typeof SERVER_ANALYTICS_EVENTS)[keyof typeof SERVER_ANALYTICS_EVENTS],
  input: {
    userId?: string | null;
    entityId: string;
    idempotencyKey?: string;
    properties?: Record<string, unknown>;
    occurredAt?: string;
  },
): void {
  try {
    if (!input.idempotencyKey && !UUID.test(input.entityId)) return;
    const row = toAnalyticsRow(
      {
        eventName,
        idempotencyKey: input.idempotencyKey ?? serverIdempotencyKey(eventName, input.entityId),
        platform: "server",
        properties: input.properties ?? {},
        occurredAt: input.occurredAt,
      },
      {
        userId: input.userId ?? null,
        environment: resolveAnalyticsEnvironment(env),
      },
    );
    void insertAnalyticsEvent(env, row).catch(() => undefined);
  } catch {
    /* observational — never change caller success or failure */
  }
}

export async function insertAnalyticsEvent(
  env: Env,
  row: AnalyticsRow,
): Promise<{ inserted: boolean; eventId: string | null }> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return { inserted: false, eventId: null };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/ingest_analytics_event`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_id: row.id,
      p_idempotency_key: row.idempotency_key,
      p_user_id: row.user_id,
      p_anonymous_id: row.anonymous_id,
      p_session_id: row.session_id,
      p_event_name: row.event_name,
      p_event_version: row.event_version,
      p_platform: row.platform,
      p_app_version: row.app_version,
      p_os: row.os,
      p_device_type: row.device_type,
      p_environment: row.environment,
      p_properties: row.properties,
      p_acquisition_source: row.acquisition_source,
      p_utm_source: row.utm_source,
      p_utm_medium: row.utm_medium,
      p_utm_campaign: row.utm_campaign,
      p_utm_content: row.utm_content,
      p_utm_term: row.utm_term,
      p_country_code: row.country_code,
      p_occurred_at: row.occurred_at,
    }),
  });
  if (response.status === 409) return { inserted: false, eventId: row.id };
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new HttpError(502, "Could not record that analytics event.");
  }
  const body = (await response.json().catch(() => null)) as
    | Array<{ inserted?: boolean; event_id?: string }>
    | { inserted?: boolean; event_id?: string }
    | null;
  const rowOut = Array.isArray(body) ? body[0] : body;
  return {
    inserted: rowOut?.inserted !== false,
    eventId: rowOut?.event_id ?? row.id,
  };
}

function isReservedIdempotencyKey(value: string): boolean {
  return Object.values(SERVER_ANALYTICS_EVENTS).some((name) => value.startsWith(`${name}:`));
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  if (!next) return undefined;
  return next.slice(0, max);
}

function optionalUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function optionalIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "occurredAt is invalid.");
  return date.toISOString();
}
