import { HttpError, json } from "./http";
import { requireUser, serviceRest } from "./shared";
import type { Env } from "./env";
import { isExpoPushToken } from "./push";

export async function handlePush(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/push")) return null;
  if (url.pathname !== "/v1/push/tokens") throw new HttpError(404, "Not found.");
  const user = await requireUser(request, env);

  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { expoPushToken?: string; platform?: string };
    const token = typeof body.expoPushToken === "string" ? body.expoPushToken.trim() : "";
    if (!isExpoPushToken(token)) throw new HttpError(400, "Expo push token is invalid.");
    const platform = body.platform === "android" ? "android" : "ios";
    const existing = await serviceRest<Array<{ id: string }>>(
      env,
      "GET",
      `/push_tokens?expo_push_token=eq.${encodeURIComponent(token)}&select=id`,
    );
    if (existing[0]) {
      await serviceRest(env, "PATCH", `/push_tokens?id=eq.${existing[0].id}`, {
        user_id: user.id,
        platform,
        updated_at: new Date().toISOString(),
      });
    } else {
      await serviceRest(env, "POST", "/push_tokens", {
        user_id: user.id,
        expo_push_token: token,
        platform,
      });
    }
    return json({ ok: true });
  }

  if (request.method === "DELETE") {
    const body = (await request.json().catch(() => ({}))) as { expoPushToken?: string };
    const token = typeof body.expoPushToken === "string" ? body.expoPushToken.trim() : "";
    if (token) {
      await serviceRest(env, "DELETE", `/push_tokens?user_id=eq.${user.id}&expo_push_token=eq.${encodeURIComponent(token)}`);
    } else {
      await serviceRest(env, "DELETE", `/push_tokens?user_id=eq.${user.id}`);
    }
    return json({ ok: true });
  }

  throw new HttpError(405, "Method not allowed.");
}
