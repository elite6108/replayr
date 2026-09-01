import type { Env } from "./env";
import { FOLDER_UUID, loadProfileCards, requireFolderPermission } from "./folders";
import { HttpError, json } from "./http";
import { requireUser, serviceRest } from "./shared";
import type { FolderActivity, FolderActivityKind, SocialUser } from "./social-types";

type ActivityRow = {
  id: string;
  folder_id: string;
  actor_id: string;
  kind: FolderActivityKind;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export async function handleFolderActivity(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/v1\/folders\/([^/]+)\/activity$/);
  if (!match?.[1] || request.method !== "GET") return null;
  return listFolderActivity(request, env, match[1], url);
}

export async function logFolderActivity(
  env: Env,
  event: {
    folderId: string;
    actorId: string;
    kind: FolderActivityKind;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await serviceRest(
      env,
      "POST",
      "/folder_activity",
      {
        folder_id: event.folderId,
        actor_id: event.actorId,
        kind: event.kind,
        entity_id: event.entityId ?? null,
        metadata: event.metadata ?? {},
      },
      "return=minimal",
    );
  } catch {
    // Activity is best-effort. Mutating the folder must still succeed.
  }
}

async function listFolderActivity(request: Request, env: Env, folderId: string, url: URL): Promise<Response> {
  const user = await requireUser(request, env);
  if (!FOLDER_UUID.test(folderId)) throw new HttpError(404, "That folder was not found.");
  await requireFolderPermission(env, folderId, user.id, "view");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const rows = await serviceRest<ActivityRow[]>(
    env,
    "GET",
    `/folder_activity?folder_id=eq.${folderId}&select=id,folder_id,actor_id,kind,entity_id,metadata,created_at&order=created_at.desc&limit=${limit}`,
  );
  const people = await loadProfileCards(
    env,
    rows.map((row) => row.actor_id),
  );
  return json({
    activities: rows.map((row) => presentActivity(row, people.get(row.actor_id) ?? fallbackUser(row.actor_id))),
  });
}

function presentActivity(row: ActivityRow, actor: SocialUser): FolderActivity {
  return {
    id: row.id,
    folderId: row.folder_id,
    kind: row.kind,
    entityId: row.entity_id,
    actor,
    createdAt: row.created_at,
    summary: activitySummary(actor.displayName, row.kind, row.metadata),
  };
}

function activitySummary(name: string, kind: FolderActivityKind, metadata: Record<string, unknown> | null): string {
  const extra = metadata ?? {};
  if (kind === "edit_created") {
    return typeof extra.duplicatedFrom === "string" ? `${name} duplicated an edit` : `${name} created an edit`;
  }
  if (kind === "edit_rendered") return `${name} rendered an edited copy`;
  if (kind === "edit_deleted") return `${name} deleted an edit`;
  if (kind === "clip_added") return `${name} added clips`;
  if (kind === "clip_removed") return `${name} removed a clip`;
  if (kind === "member_role_changed") {
    const role = typeof extra.role === "string" ? extra.role : "a role";
    return `${name} changed a member to ${role}`;
  }
  if (kind === "ownership_transferred") return `${name} transferred ownership`;
  return `${name} updated the folder`;
}

function fallbackUser(id: string): SocialUser {
  return { id, username: null, displayName: "Player", avatarUrl: null, verified: false };
}
