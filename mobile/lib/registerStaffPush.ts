import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { registerPushToken, unregisterPushToken } from "./api.staff";

let lastExpoToken: string | null = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type PushOpenTarget =
  | { kind: "staff-task"; taskId: string }
  | { kind: "clip"; slug: string }
  | { kind: "message"; conversationId: string };

export function targetFromPushData(data: unknown): PushOpenTarget | null {
  if (!data || typeof data !== "object") return null;
  const row = data as { type?: unknown; staffTaskId?: unknown; slug?: unknown; conversationId?: unknown };
  if (row.type === "staff_task" && typeof row.staffTaskId === "string") {
    return { kind: "staff-task", taskId: row.staffTaskId };
  }
  if (row.type === "clip" && typeof row.slug === "string") {
    return { kind: "clip", slug: row.slug };
  }
  if (row.type === "message" && typeof row.conversationId === "string") {
    return { kind: "message", conversationId: row.conversationId };
  }
  return null;
}

export function staffTaskIdFromPushData(data: unknown): string | null {
  const target = targetFromPushData(data);
  return target?.kind === "staff-task" ? target.taskId : null;
}

export async function registerStaffPush(accessToken: string): Promise<void> {
  if (Platform.OS === "web") return;
  if (!Device.isDevice) return;
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== "granted") return;
  const token = (await Notifications.getExpoPushTokenAsync()).data;
  lastExpoToken = token;
  await registerPushToken(accessToken, token, Platform.OS);
}

export async function unregisterStaffPush(accessToken: string): Promise<void> {
  const token = lastExpoToken;
  lastExpoToken = null;
  try {
    await unregisterPushToken(accessToken, token ?? undefined);
  } catch {
    /* sign-out still proceeds */
  }
}
