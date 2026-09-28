import type { Env } from "./env";
import { serviceRest } from "./shared";

export type StaffActorCard = {
  id: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  userId: string | null;
};

export async function loadStaffActorCards(env: Env, staffIds: string[]): Promise<Map<string, StaffActorCard>> {
  const ids = [...new Set(staffIds.filter(Boolean))];
  const map = new Map<string, StaffActorCard>();
  if (!ids.length) return map;
  const members = await serviceRest<Array<{ id: string; display_name: string; user_id: string | null }>>(
    env,
    "GET",
    `/staff_members?id=in.(${ids.join(",")})&select=id,display_name,user_id`,
  );
  const userIds = [...new Set(members.map((row) => row.user_id).filter((id): id is string => Boolean(id)))];
  const profiles = userIds.length
    ? await serviceRest<Array<{ id: string; username: string | null; avatar_url: string | null }>>(
        env,
        "GET",
        `/profiles?id=in.(${userIds.join(",")})&select=id,username,avatar_url`,
      )
    : [];
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  for (const member of members) {
    const profile = member.user_id ? profileById.get(member.user_id) : undefined;
    map.set(member.id, {
      id: member.id,
      displayName: member.display_name || "Staff",
      username: profile?.username ?? null,
      avatarUrl: profile?.avatar_url ?? null,
      userId: member.user_id,
    });
  }
  return map;
}

export async function addTaskActivity(
  env: Env,
  taskId: string,
  actorStaffId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await serviceRest(env, "POST", "/staff_task_activity", {
    task_id: taskId,
    actor_staff_id: actorStaffId,
    action,
    metadata,
  });
}
