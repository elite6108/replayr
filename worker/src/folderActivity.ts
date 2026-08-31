import type { Env } from "./env";
import { serviceRest } from "./shared";
import type { FolderActivityKind } from "./social-types";

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
