import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import type { Href } from "expo-router";
import { registerPushToken, unregisterPushToken } from "./api.friends";
import { threadHref } from "./api.messages";

const ENABLED_KEY = "replayr_push_enabled";
const TOKEN_KEY = "replayr_push_token";
const PROMPTED_KEY = "replayr_push_prompted";
const PROJECT_ID = "90989ccf-3954-4736-b4e6-8602e8f7d1a0";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type PushPermission = "undetermined" | "granted" | "denied";

export async function getPushPermission(): Promise<PushPermission> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return "granted";
  if (current.status === "denied" || current.canAskAgain === false) return "denied";
  return "undetermined";
}

export async function isPushEnabledLocally(): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(ENABLED_KEY);
  return stored !== "0";
}

export async function setPushEnabledLocally(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(ENABLED_KEY, enabled ? "1" : "0");
}

export async function requestPushPermission(): Promise<PushPermission> {
  const current = await getPushPermission();
  if (current !== "undetermined") return current;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted ? "granted" : "denied";
}

export async function openSystemNotificationSettings(): Promise<void> {
  if (Platform.OS === "ios") {
    await Linking.openURL("app-settings:");
    return;
  }
  await Linking.openSettings();
}

export async function syncPushForSession(accessToken: string): Promise<PushPermission> {
  let permission = await getPushPermission();
  const enabled = await isPushEnabledLocally();
  const prompted = await SecureStore.getItemAsync(PROMPTED_KEY);
  if (!prompted && permission === "undetermined" && enabled) {
    permission = await requestPushPermission();
    await SecureStore.setItemAsync(PROMPTED_KEY, "1");
    if (permission !== "granted") {
      await setPushEnabledLocally(false);
      return permission;
    }
  }
  if (permission !== "granted" || !enabled) return permission;
  await ensureAndroidChannel();
  const token = await getExpoToken();
  if (!token) return permission;
  await registerPushToken(accessToken, { token, platform: Platform.OS === "android" ? "android" : "ios" });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return permission;
}

export async function enablePush(accessToken: string): Promise<PushPermission> {
  const permission = await requestPushPermission();
  await SecureStore.setItemAsync(PROMPTED_KEY, "1");
  if (permission !== "granted") {
    await setPushEnabledLocally(false);
    return permission;
  }
  await setPushEnabledLocally(true);
  await syncPushForSession(accessToken);
  return permission;
}

export async function disablePush(accessToken?: string | null): Promise<void> {
  await setPushEnabledLocally(false);
  await unregisterCurrentPushToken(accessToken);
}

export async function unregisterCurrentPushToken(accessToken?: string | null): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (accessToken && token) {
    await unregisterPushToken(accessToken, token).catch(() => undefined);
  }
}

export function routeFromPushData(data: Record<string, unknown> | undefined, push: (href: Href) => void) {
  if (!data) return;
  const kind = typeof data.kind === "string" ? data.kind : "";
  const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
  const clipSlug = typeof data.clipSlug === "string" ? data.clipSlug : "";
  const username = typeof data.username === "string" ? data.username : "";
  if (kind === "friend_request") {
    push("/friends");
    return;
  }
  if (kind === "friend_accept" && username) {
    push(`/u/${username}`);
    return;
  }
  if ((kind === "message" || kind === "group_invite") && conversationId) {
    push(threadHref(conversationId));
    return;
  }
  if ((kind === "clip_like" || kind === "clip_comment") && clipSlug) {
    push(`/c/${clipSlug}`);
  }
}

async function getExpoToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? PROJECT_ID;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    return result.data;
  } catch {
    return null;
  }
}

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "Replayr",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#7fd0ef",
  });
}
