import { apiUrl } from "./supabase";

const seen = new Set<string>();

export function installMobileTelemetry() {
  const globalWithHandler = globalThis as {
    ErrorUtils?: {
      getGlobalHandler?: () => ((error: Error, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
    };
  };
  const utils = globalWithHandler.ErrorUtils;
  if (!utils?.getGlobalHandler || !utils.setGlobalHandler) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    reportMobileError({
      message: error?.message || "Native error",
      stack: error?.stack,
      level: isFatal ? "crash" : "error",
    });
    previous?.(error, isFatal);
  });
}

export function reportMobileError(input: {
  message: string;
  stack?: string;
  path?: string;
  level?: "error" | "crash";
}) {
  const message = (input.message || "").trim();
  if (!message) return;
  const key = message.slice(0, 160);
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 40) seen.clear();
  void fetch(apiUrl("/v1/errors"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      surface: "mobile",
      level: input.level ?? "error",
      message,
      stack: input.stack?.slice(0, 4000),
      path: input.path?.slice(0, 160),
      release: "mobile",
    }),
  }).catch(() => {
    /* never throw from telemetry */
  });
}
