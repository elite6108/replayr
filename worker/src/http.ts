export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const APP_ORIGINS = new Set([
  "https://replayr.tv",
  "https://www.replayr.tv",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "asset://localhost",
]);

const LOCAL_DEV_ORIGINS = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
]);

function isLocalHostname(host: string) {
  return host === "localhost" || host === "127.0.0.1";
}

export function localPublicApp(value: string | undefined) {
  if (!value) return false;
  try {
    return isLocalHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function originAllowed(origin: string, request?: Request, localDev = false): boolean {
  if (APP_ORIGINS.has(origin)) return true;
  if (!LOCAL_DEV_ORIGINS.has(origin)) return false;
  // `wrangler dev` rewrites request.url to the production route, so the
  // hostname check alone rejects the desktop and website while developing.
  if (localDev) return true;
  if (!request) return false;
  try {
    return isLocalHostname(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

export function clientFacingOrigin(request: Request, fallbackOrigin: string) {
  const origin = request.headers.get("origin");
  if (origin && originAllowed(origin, request) && /^https?:\/\//i.test(origin) && !origin.includes("tauri")) {
    return origin.replace(/\/$/, "");
  }
  const fallback = fallbackOrigin.replace(/\/$/, "");
  if (fallback.includes("replayr.tv")) return "https://www.replayr.tv";
  return fallback;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
}

export function cors(response: Response, request?: Request, localDev = false) {
  const headers = new Headers(response.headers);
  const origin = request?.headers.get("origin");
  if (origin && originAllowed(origin, request, localDev)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set("access-control-expose-headers", "location, content-disposition, content-type");
  }
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}
