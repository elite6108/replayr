import { apiUrl } from "./supabase";

const seen = new Set<string>();

export function installWebTelemetry() {
  window.addEventListener("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    reportClientError({ surface: "web", level: "error", message, stack, path: window.location.pathname });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportClientError({ surface: "web", level: "error", message, stack, path: window.location.pathname });
  });
}

export function reportClientError(input: {
  surface: "desktop" | "web" | "mobile";
  level?: "error" | "crash";
  message: string;
  stack?: string;
  path?: string;
  release?: string;
  accessToken?: string | null;
  endpoint?: string;
}) {
  const message = (input.message || "").trim();
  if (!message || message === "Script error." || message.includes("ResizeObserver")) return;
  const key = `${input.surface}:${message.slice(0, 160)}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 40) seen.clear();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (input.accessToken) headers.authorization = `Bearer ${input.accessToken}`;
  const url = input.endpoint || apiUrl("/v1/errors");
  void fetch(url, {
    method: "POST",
    headers,
    keepalive: true,
    body: JSON.stringify({
      surface: input.surface,
      level: input.level ?? "error",
      message,
      stack: input.stack?.slice(0, 4000),
      path: input.path?.slice(0, 160),
      release: input.release?.slice(0, 40),
    }),
  }).catch(() => {
    /* never throw from telemetry */
  });
}
