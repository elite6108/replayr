import { publicApiUrl } from "../branding";
import { useAuthStore } from "../stores/authStore";

const seen = new Set<string>();
const recentReports = new Map<string, { at: number; hadStack: boolean }>();

function scrubPaths(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s"']+/g, (path) => {
    const parts = path.split("\\");
    return parts[parts.length - 1] || "recording";
  });
}

export function installDesktopTelemetry() {
  window.addEventListener("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    reportDesktopError({ message, stack, path: window.location.hash || window.location.pathname });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportDesktopError({
      message: reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection"),
      stack: reason instanceof Error ? reason.stack : undefined,
      path: window.location.hash || window.location.pathname,
    });
  });
}

export function reportDesktopError(input: {
  message: string;
  stack?: string;
  path?: string;
  always?: boolean;
}) {
  const message = scrubPaths((input.message || "").trim());
  if (!message || message.includes("ResizeObserver")) return;
  const stack = input.stack ? scrubPaths(input.stack) : undefined;
  const key = message.slice(0, 160);
  if (input.always) {
    const now = Date.now();
    const last = recentReports.get(key);
    const richer = Boolean(stack) && !last?.hadStack;
    if (last && now - last.at < 3000 && !richer) return;
    recentReports.set(key, { at: now, hadStack: Boolean(stack) || Boolean(last?.hadStack) });
  } else {
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 40) seen.clear();
  }
  void (async () => {
    let release = "desktop";
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      release = `desktop-${await getVersion()}`;
    } catch {
      release = "desktop";
    }
    const token = useAuthStore.getState().session?.access_token;
    await fetch(`${publicApiUrl()}/v1/errors`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      keepalive: true,
      body: JSON.stringify({
        surface: "desktop",
        level: "error",
        message,
        stack: stack?.slice(0, 4000),
        path: input.path?.slice(0, 160),
        release,
      }),
    });
  })().catch(() => {
    /* never throw from telemetry */
  });
}
