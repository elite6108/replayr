import type { Env } from "./env";
import { HttpError } from "./http";
import {
  createContentReport,
  listModerationReports,
  resolveModerationReport,
  unsuspendModerationUser,
} from "./moderationReports";
import { createModerationTerm, listModerationTerms, updateModerationTerm } from "./moderationTerms";
import type { StaffActor } from "./staffAuth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleUserModeration(
  request: Request,
  env: Env,
  url: URL,
  ctx?: { waitUntil(task: Promise<unknown>): void },
): Promise<Response | null> {
  if (url.pathname === "/v1/reports" && request.method === "POST") {
    return createContentReport(request, env, ctx);
  }
  return null;
}

export async function handleModerationAdmin(
  request: Request,
  env: Env,
  url: URL,
  actor: StaffActor,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/moderation")) return null;
  const path = url.pathname;
  const method = request.method;

  if (path === "/v1/admin/moderation/reports" && method === "GET") return listModerationReports(env, url);
  const resolve = path.match(/^\/v1\/admin\/moderation\/reports\/([^/]+)\/resolve$/);
  if (resolve?.[1] && method === "POST") return resolveModerationReport(request, env, actor, resolve[1]);
  const unsuspend = path.match(/^\/v1\/admin\/moderation\/users\/([^/]+)\/unsuspend$/);
  if (unsuspend?.[1] && method === "POST") return unsuspendModerationUser(env, actor, unsuspend[1]);

  if (path === "/v1/admin/moderation/terms" && method === "GET") return listModerationTerms(env, url);
  if (path === "/v1/admin/moderation/terms" && method === "POST") return createModerationTerm(request, env, actor);
  const term = path.match(/^\/v1\/admin\/moderation\/terms\/([^/]+)$/);
  if (term?.[1] && method === "PATCH") {
    if (!UUID.test(term[1])) throw new HttpError(404, "That term was not found.");
    return updateModerationTerm(request, env, actor, term[1]);
  }

  throw new HttpError(404, "That moderation route was not found.");
}
