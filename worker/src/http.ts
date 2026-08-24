export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ALLOWED_ORIGINS = new Set([
  "https://replayr.tv",
  "https://www.replayr.tv",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
}

export function cors(response: Response, request?: Request) {
  const headers = new Headers(response.headers);
  const origin = request?.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}
