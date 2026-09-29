import type { Env } from "./env";
import { sendExpoPush, type ExpoPushData } from "./push";
import { serviceRest } from "./shared";

export const SOCIAL_PUSH_KINDS = new Set(["message", "clip_like", "clip_comment"]);

export type InboxPushRow = {
  user_id: string;
  kind: string;
  actor_id?: string | null;
  conversation_id?: string | null;
  clip_id?: string | null;
};

export function socialPushCopy(kind: string, actorName: string): { title: string; body: string } | null {
  const name = actorName.trim() || "Someone";
  if (kind === "clip_like") return { title: name, body: "liked your clip" };
  if (kind === "clip_comment") return { title: name, body: "commented on your clip" };
  if (kind === "message") return { title: name, body: "sent you a message" };
  return null;
}

export async function fanOutInboxPush(env: Env, rows: InboxPushRow[]): Promise<void> {
  const pending = rows.filter(
    (row) => SOCIAL_PUSH_KINDS.has(row.kind) && row.user_id && row.user_id !== row.actor_id,
  );
  if (!pending.length) return;

  const actorIds = [...new Set(pending.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))];
  const clipIds = [...new Set(pending.map((row) => row.clip_id).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await serviceRest<Array<{ id: string; display_name: string | null; username: string | null }>>(
        env,
        "GET",
        `/profiles?id=in.(${actorIds.join(",")})&select=id,display_name,username`,
      )
    : [];
  const clips = clipIds.length
    ? await serviceRest<Array<{ id: string; slug: string }>>(
        env,
        "GET",
        `/clips?id=in.(${clipIds.join(",")})&select=id,slug`,
      )
    : [];
  const nameById = new Map(
    actors.map((row) => [row.id, (row.display_name || row.username || "Someone").trim() || "Someone"]),
  );
  const slugById = new Map(clips.map((row) => [row.id, row.slug]));

  for (const row of pending) {
    const copy = socialPushCopy(row.kind, nameById.get(row.actor_id || "") || "Someone");
    if (!copy) continue;
    const data = pushDataForRow(row, slugById);
    if (!data) continue;
    await sendExpoPush(env, [row.user_id], { title: copy.title, body: copy.body, data });
  }
}

function pushDataForRow(row: InboxPushRow, slugById: Map<string, string>): ExpoPushData | null {
  if (row.kind === "message" && row.conversation_id) {
    return { type: "message", conversationId: row.conversation_id };
  }
  if ((row.kind === "clip_like" || row.kind === "clip_comment") && row.clip_id) {
    const slug = slugById.get(row.clip_id);
    if (!slug) return null;
    return { type: "clip", slug };
  }
  return null;
}
