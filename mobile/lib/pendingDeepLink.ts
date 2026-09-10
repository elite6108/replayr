import * as SecureStore from "expo-secure-store";

const KEY = "replayr.pendingDeepLink";
let memory: string | null = null;

/** Store an in-app path like `/c/abc123` to resume after sign-in. */
export async function setPendingDeepLink(href: string | null | undefined) {
  const next = href?.trim() ?? null;
  if (!next || !next.startsWith("/")) {
    memory = null;
    try {
      await SecureStore.deleteItemAsync(KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  memory = next;
  try {
    await SecureStore.setItemAsync(KEY, next);
  } catch {
    /* memory fallback only */
  }
}

export async function takePendingDeepLink(): Promise<string | null> {
  let value = memory;
  memory = null;
  try {
    value = (await SecureStore.getItemAsync(KEY)) ?? value;
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* ignore */
  }
  return value;
}
