import type { Env } from "./env";
import type { WaitUntilCtx } from "./boardActivity";
import { serviceRest } from "./shared";

const EXPO_TOKEN = /^ExponentPushToken\[[\w-]+\]$/;
const EXPO_URL = "https://exp.host/--/api/v2/push/send";

export type ExpoPushData =
  | { type: "staff_task"; staffTaskId: string; boardId: string }
  | { type: "clip"; slug: string }
  | { type: "message"; conversationId: string };

export type ExpoPushPayload = {
  title: string;
  body: string;
  data: ExpoPushData;
};

export function isExpoPushToken(value: string) {
  return EXPO_TOKEN.test(value.trim());
}

export function queueExpoPush(
  ctx: WaitUntilCtx | undefined,
  env: Env,
  userIds: string[],
  payload: ExpoPushPayload,
): void {
  const work = sendExpoPush(env, userIds, payload).catch((caught) => {
    console.error("Expo push failed", {
      message: caught instanceof Error ? caught.message : "Unknown error",
      type: payload.data.type,
    });
  });
  if (ctx?.waitUntil) ctx.waitUntil(work);
}

export async function sendExpoPush(env: Env, userIds: string[], payload: ExpoPushPayload): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return;
  const tokens = await serviceRest<Array<{ expo_push_token: string }>>(
    env,
    "GET",
    `/push_tokens?user_id=in.(${unique.join(",")})&select=expo_push_token`,
  );
  const messages = tokens
    .map((row) => row.expo_push_token)
    .filter(isExpoPushToken)
    .map((to) => ({
      to,
      title: payload.title.slice(0, 80),
      body: payload.body.slice(0, 140),
      sound: "default",
      data: payload.data,
    }));
  if (!messages.length) return;

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const response = await fetch(EXPO_URL, { method: "POST", headers, body: JSON.stringify(chunk) });
    if (!response.ok) {
      console.error("Expo push HTTP error", { status: response.status });
    }
  }
}
