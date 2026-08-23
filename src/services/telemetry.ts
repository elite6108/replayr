import { publicApiUrl } from "../branding";

const seen = new Set<string>();

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

export function reportDesktopError(input: { message: string; stack?: string; path?: string }) {
  const message = (input.message || "").trim();
  if (!message || message.includes("ResizeObserver")) return;
  const key = message.slice(0, 160);
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 40) seen.clear();
  void (async () => {
    let release = "desktop";
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      release = `desktop-${await getVersion()}`;
    } catch {
      release = "desktop";
    }
    await fetch(`${publicApiUrl()}/v1/errors`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      keepalive: true,
      body: JSON.stringify({
        surface: "desktop",
        level: "error",
        message,
        stack: input.stack?.slice(0, 4000),
        path: input.path?.slice(0, 160),
        release,
      }),
    });
  })().catch(() => {
    /* never throw from telemetry */
  });
}
