import type { Env } from "./env";
import { logFolderActivity } from "./folderActivity";
import {
  FOLDER_UUID,
  loadProfileCards,
  requireFolderPermission,
  type FolderAccess,
} from "./folders";
import { HttpError, json } from "./http";
import { requireUser, serviceRest } from "./shared";
import type {
  FolderEdit,
  FolderEditDocument,
  FolderPermissions,
  SocialUser,
} from "./social-types";

type EditRow = {
  id: string;
  folder_id: string;
  clip_id: string;
  created_by: string;
  updated_by: string;
  name: string;
  edit_data: FolderEditDocument;
  revision: number;
  rendered_clip_id: string | null;
  created_at: string;
  updated_at: string;
};

const EDIT_SELECT =
  "id,folder_id,clip_id,created_by,updated_by,name,edit_data,revision,rendered_clip_id,created_at,updated_at";

export async function handleFolderEdits(request: Request, env: Env, url: URL): Promise<Response | null> {
  const duplicate = url.pathname.match(
    /^\/v1\/folders\/([^/]+)\/clips\/([^/]+)\/edits\/([^/]+)\/duplicate$/,
  );
  if (duplicate?.[1] && duplicate[2] && duplicate[3] && request.method === "POST") {
    return duplicateEdit(request, env, duplicate[1], duplicate[2], duplicate[3]);
  }

  const render = url.pathname.match(
    /^\/v1\/folders\/([^/]+)\/clips\/([^/]+)\/edits\/([^/]+)\/render$/,
  );
  if (render?.[1] && render[2] && render[3] && request.method === "POST") {
    return renderEdit(request, env, render[1], render[2], render[3]);
  }

  const one = url.pathname.match(/^\/v1\/folders\/([^/]+)\/clips\/([^/]+)\/edits\/([^/]+)$/);
  if (one?.[1] && one[2] && one[3] && request.method === "GET") {
    return getEdit(request, env, one[1], one[2], one[3]);
  }
  if (one?.[1] && one[2] && one[3] && request.method === "PATCH") {
    return updateEdit(request, env, one[1], one[2], one[3]);
  }
  if (one?.[1] && one[2] && one[3] && request.method === "DELETE") {
    return deleteEdit(request, env, one[1], one[2], one[3]);
  }

  const list = url.pathname.match(/^\/v1\/folders\/([^/]+)\/clips\/([^/]+)\/edits$/);
  if (list?.[1] && list[2] && request.method === "GET") {
    return listEdits(request, env, list[1], list[2]);
  }
  if (list?.[1] && list[2] && request.method === "POST") {
    return createEdit(request, env, list[1], list[2]);
  }

  return null;
}

export function sanitizeEditName(value: unknown, fallback = "Untitled Edit"): string {
  const raw = typeof value === "string" ? value : fallback;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length < 1 || name.length > 80) {
    throw new HttpError(400, "Edit names must be 1 to 80 characters.");
  }
  return name;
}

export function sanitizeEditDocument(value: unknown): FolderEditDocument {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const version = input.version === 1 || input.version == null ? 1 : null;
  if (version !== 1) throw new HttpError(400, "Unsupported edit document version.");
  const document: FolderEditDocument = { version: 1 };
  if (input.trim && typeof input.trim === "object" && !Array.isArray(input.trim)) {
    const trim = input.trim as { startMs?: unknown; endMs?: unknown };
    document.trim = {
      startMs: asMs(trim.startMs),
      endMs: asMs(trim.endMs),
    };
  }
  if (input.composition && typeof input.composition === "object" && !Array.isArray(input.composition)) {
    const composition = input.composition as { cropX?: unknown; webcam?: unknown };
    document.composition = {
      cropX: typeof composition.cropX === "number" ? clamp01(composition.cropX) : undefined,
      webcam: sanitizeWebcam(composition.webcam),
    };
  }
  if (input.webcam) document.webcam = sanitizeWebcam(input.webcam);
  if (input.visuals && typeof input.visuals === "object" && !Array.isArray(input.visuals)) {
    const visuals = input.visuals as { filter?: unknown; overlays?: { recIndicator?: unknown; timestamp?: unknown } };
    document.visuals = {
      filter: typeof visuals.filter === "string" ? visuals.filter.slice(0, 32) : undefined,
      overlays: visuals.overlays
        ? {
            recIndicator: Boolean(visuals.overlays.recIndicator),
            timestamp: Boolean(visuals.overlays.timestamp),
          }
        : undefined,
    };
  }
  if (Array.isArray(input.overlays)) {
    document.overlays = input.overlays
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, 20);
  }
  if (input.audio && typeof input.audio === "object" && !Array.isArray(input.audio)) {
    document.audio = {};
  }
  return document;
}

export function canDeleteFolderEdit(permissions: FolderPermissions, createdBy: string, userId: string): boolean {
  return permissions.deleteAnyEdits || (permissions.deleteOwnEdits && createdBy === userId);
}

async function listEdits(request: Request, env: Env, folderId: string, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "viewEdits");
  await requireFolderClip(env, folderId, clipId);
  const rows = await serviceRest<EditRow[]>(
    env,
    "GET",
    `/folder_clip_edits?folder_id=eq.${folderId}&clip_id=eq.${clipId}&select=${EDIT_SELECT}&order=updated_at.desc`,
  );
  return json({ edits: await presentEdits(env, rows, access, user.id) });
}

async function createEdit(request: Request, env: Env, folderId: string, clipId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "createEdits");
  await requireFolderClip(env, folderId, clipId);
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; editData?: unknown };
  const name = sanitizeEditName(body.name);
  const editData = sanitizeEditDocument(body.editData);
  const rows = await serviceRest<EditRow[]>(
    env,
    "POST",
    "/folder_clip_edits",
    {
      folder_id: folderId,
      clip_id: clipId,
      created_by: user.id,
      updated_by: user.id,
      name,
      edit_data: editData,
      revision: 1,
    },
    "return=representation",
  );
  const created = rows[0];
  if (!created) throw new HttpError(502, "Could not create that edit.");
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "edit_created",
    entityId: created.id,
  });
  return json({ edit: (await presentEdits(env, [created], access, user.id))[0] }, 201);
}

async function getEdit(request: Request, env: Env, folderId: string, clipId: string, editId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "viewEdits");
  const edit = await loadEdit(env, folderId, clipId, editId);
  return json({ edit: (await presentEdits(env, [edit], access, user.id))[0] });
}

async function updateEdit(request: Request, env: Env, folderId: string, clipId: string, editId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "modifyEdits");
  const current = await loadEdit(env, folderId, clipId, editId);
  const body = (await request.json().catch(() => ({}))) as {
    expectedRevision?: unknown;
    name?: unknown;
    editData?: unknown;
  };
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "expectedRevision is required.");
  }
  if (body.expectedRevision !== current.revision) {
    throw new HttpError(409, "This edit was changed by another collaborator. Reload or save as a new version.");
  }
  const patch: Record<string, unknown> = {
    updated_by: user.id,
    revision: current.revision + 1,
  };
  if (body.name !== undefined) patch.name = sanitizeEditName(body.name);
  if (body.editData !== undefined) patch.edit_data = sanitizeEditDocument(body.editData);
  const rows = await serviceRest<EditRow[]>(
    env,
    "PATCH",
    `/folder_clip_edits?id=eq.${editId}&folder_id=eq.${folderId}&clip_id=eq.${clipId}&revision=eq.${current.revision}`,
    patch,
    "return=representation",
  );
  const updated = rows[0];
  if (!updated) {
    throw new HttpError(409, "This edit was changed by another collaborator. Reload or save as a new version.");
  }
  return json({ edit: (await presentEdits(env, [updated], access, user.id))[0] });
}

async function deleteEdit(request: Request, env: Env, folderId: string, clipId: string, editId: string): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "viewEdits");
  const edit = await loadEdit(env, folderId, clipId, editId);
  if (!canDeleteFolderEdit(access.permissions, edit.created_by, user.id)) {
    throw new HttpError(403, "You do not have permission to do that.");
  }
  await serviceRest(env, "DELETE", `/folder_clip_edits?id=eq.${editId}&folder_id=eq.${folderId}`);
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "edit_deleted",
    entityId: edit.id,
  });
  return json({ ok: true });
}

async function duplicateEdit(
  request: Request,
  env: Env,
  folderId: string,
  clipId: string,
  editId: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "createEdits");
  const source = await loadEdit(env, folderId, clipId, editId);
  const name = sanitizeEditName(`${source.name} copy`.slice(0, 80));
  const rows = await serviceRest<EditRow[]>(
    env,
    "POST",
    "/folder_clip_edits",
    {
      folder_id: folderId,
      clip_id: clipId,
      created_by: user.id,
      updated_by: user.id,
      name,
      edit_data: sanitizeEditDocument(source.edit_data),
      revision: 1,
    },
    "return=representation",
  );
  const created = rows[0];
  if (!created) throw new HttpError(502, "Could not duplicate that edit.");
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "edit_created",
    entityId: created.id,
    metadata: { duplicatedFrom: source.id },
  });
  return json({ edit: (await presentEdits(env, [created], access, user.id))[0] }, 201);
}

async function renderEdit(
  request: Request,
  env: Env,
  folderId: string,
  clipId: string,
  editId: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  const access = await requireFolderPermission(env, folderId, user.id, "renderEdits");
  const edit = await loadEdit(env, folderId, clipId, editId);
  const body = (await request.json().catch(() => ({}))) as { clipId?: unknown };
  const derivativeId = typeof body.clipId === "string" ? body.clipId : "";
  if (!FOLDER_UUID.test(derivativeId)) throw new HttpError(400, "Upload a rendered copy first.");
  if (derivativeId === clipId) {
    throw new HttpError(400, "A rendered copy cannot replace the source clip.");
  }
  const clips = await serviceRest<Array<{ id: string; user_id: string; status: string }>>(
    env,
    "GET",
    `/clips?id=eq.${derivativeId}&user_id=eq.${user.id}&status=eq.ready&select=id,user_id,status`,
  );
  if (!clips[0]) throw new HttpError(400, "Only your ready cloud clips can be saved as a rendered copy.");

  try {
    await serviceRest(
      env,
      "POST",
      "/folder_clips?on_conflict=folder_id,clip_id",
      [{ folder_id: folderId, clip_id: derivativeId, added_by: user.id }],
      "resolution=ignore-duplicates,return=minimal",
    );
  } catch (caught) {
    if (!(caught instanceof HttpError) || caught.status !== 409) throw caught;
  }

  const rows = await serviceRest<EditRow[]>(
    env,
    "PATCH",
    `/folder_clip_edits?id=eq.${editId}&folder_id=eq.${folderId}&clip_id=eq.${clipId}`,
    { rendered_clip_id: derivativeId, updated_by: user.id },
    "return=representation",
  );
  const updated = rows[0] ?? { ...edit, rendered_clip_id: derivativeId, updated_by: user.id };
  void logFolderActivity(env, {
    folderId,
    actorId: user.id,
    kind: "edit_rendered",
    entityId: edit.id,
    metadata: { renderedClipId: derivativeId },
  });
  return json({ edit: (await presentEdits(env, [updated], access, user.id))[0] });
}

async function requireFolderClip(env: Env, folderId: string, clipId: string): Promise<void> {
  if (!FOLDER_UUID.test(clipId)) throw new HttpError(404, "That clip was not found in this folder.");
  const rows = await serviceRest<Array<{ clip_id: string }>>(
    env,
    "GET",
    `/folder_clips?folder_id=eq.${folderId}&clip_id=eq.${clipId}&select=clip_id`,
  );
  if (!rows[0]) throw new HttpError(404, "That clip was not found in this folder.");
}

async function loadEdit(env: Env, folderId: string, clipId: string, editId: string): Promise<EditRow> {
  if (!FOLDER_UUID.test(folderId) || !FOLDER_UUID.test(clipId) || !FOLDER_UUID.test(editId)) {
    throw new HttpError(404, "That edit was not found.");
  }
  await requireFolderClip(env, folderId, clipId);
  const rows = await serviceRest<EditRow[]>(
    env,
    "GET",
    `/folder_clip_edits?id=eq.${editId}&folder_id=eq.${folderId}&clip_id=eq.${clipId}&select=${EDIT_SELECT}`,
  );
  if (!rows[0]) throw new HttpError(404, "That edit was not found.");
  return rows[0];
}

async function presentEdits(
  env: Env,
  rows: EditRow[],
  access: FolderAccess,
  userId: string,
): Promise<FolderEdit[]> {
  const people = await loadProfileCards(
    env,
    rows.flatMap((row) => [row.created_by, row.updated_by]),
  );
  return rows.map((row) => ({
    id: row.id,
    folderId: row.folder_id,
    clipId: row.clip_id,
    name: row.name,
    revision: row.revision,
    editData: sanitizeEditDocument(row.edit_data),
    renderedClipId: row.rendered_clip_id,
    createdBy: people.get(row.created_by) ?? fallbackUser(row.created_by),
    updatedBy: people.get(row.updated_by) ?? fallbackUser(row.updated_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canModify: access.permissions.modifyEdits,
    canDelete: canDeleteFolderEdit(access.permissions, row.created_by, userId),
    canRender: access.permissions.renderEdits,
  }));
}

function fallbackUser(id: string): SocialUser {
  return { id, username: null, displayName: "Player", avatarUrl: null, verified: false };
}

function sanitizeWebcam(value: unknown): FolderEditDocument["webcam"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const webcam = value as { placement?: unknown; shape?: unknown; width?: unknown; x?: unknown; y?: unknown };
  return {
    placement: typeof webcam.placement === "string" ? webcam.placement.slice(0, 32) : "bottom-right",
    shape: typeof webcam.shape === "string" ? webcam.shape.slice(0, 32) : "rounded",
    width: typeof webcam.width === "number" ? Math.max(0.12, Math.min(0.4, webcam.width)) : 0.22,
    x: typeof webcam.x === "number" ? clamp01(webcam.x) : null,
    y: typeof webcam.y === "number" ? clamp01(webcam.y) : null,
  };
}

function asMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
