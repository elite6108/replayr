import { comingSoonContentSecurityPolicy } from "./contentSecurity";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireServiceRole, requireUser, serviceRest } from "./shared";
import { publicSiteUrl, sendReplayrEmail, waitlistConfirmEmail, waitlistUnsubscribeUrl } from "./email";
import { assertDistributedRateLimit } from "./rateLimit";

const COOKIE_NAME = "replayr_site_access";
const OPEN_COOKIE = "replayr_site_open";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

const ALWAYS_OPEN_PREFIXES = [
  "/v1/",
  "/internal/",
  "/releases/",
  "/c/",
  "/clip/",
  "/f/",
  "/s/",
  "/auth/",
  "/.well-known/",
];

/** Marketing SPA routes that must work without the coming-soon cookie. */
export const PUBLIC_APP_PATHS = new Set(["/signin", "/terms", "/privacy"]);

/** Desktop/web OAuth returns must stay reachable without the site-access cookie. */
export function isOAuthHandoff(url: URL): boolean {
  if (url.pathname === "/auth/desktop" || url.pathname === "/auth/callback" || url.pathname.startsWith("/auth/")) {
    return true;
  }
  return url.pathname === "/" && url.searchParams.has("code");
}

/** Send a homepage OAuth return to the desktop handoff instead of the marketing app. */
export function oauthRootRedirect(url: URL): string | null {
  if (url.pathname !== "/") return null;
  const hasCode = url.searchParams.has("code");
  const hasError = url.searchParams.has("error") || url.searchParams.has("error_description");
  if (!hasCode && !hasError) return null;
  const target = new URL("/auth/desktop", url.origin);
  target.search = url.search;
  return `${target.pathname}${target.search}`;
}

/** Static files the locked coming-soon page needs (must stay ungated). */
export const COMING_SOON_PUBLIC_PATHS = new Set([
  "/coming-soon.html",
  "/coming-soon.js",
  "/coming-soon.css",
  "/instant-replay.png",
  "/marketing/record-preview.png",
  "/marketing/local-library.png",
  "/marketing/share-privacy.png",
  "/marketing/clip-editor.jpg",
  "/marketing/social-explore-or-following.png",
  "/marketing/overlay-pack-or-scene.png",
  "/marketing/hero-laptop.png",
  "/marketing/section-2-tablet.png",
  "/marketing/section-2-timeline.jpg",
  "/marketing/section-3-library.png",
  "/marketing/section-4-car-still.jpg",
  "/replayr-logo.png",
  "/replayr-mark.png",
  "/favicon.png",
  "/apple-touch-icon.png",
  // Sign-in, terms, and privacy are public and still render the site header.
  "/marketing/landing/windows.svg",
  "/marketing/landing/x.svg",
]);

export function normalizePublicPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function isWaitlistAliasPath(pathname: string): boolean {
  return normalizePublicPath(pathname) === "/waitlist";
}

export function isComingSoonPath(pathname: string): boolean {
  const path = normalizePublicPath(pathname);
  return path === "/coming-soon" || path === "/coming-soon.html";
}

export function waitlistAliasRedirect(url: URL): Response {
  const target = new URL("/coming-soon", url.origin);
  target.search = url.search;
  return new Response(null, {
    status: 301,
    headers: {
      location: `${target.pathname}${target.search}`,
      "cache-control": "no-store",
    },
  });
}

/** Vite lazy chunks for the operator consoles. Not public waitlist assets. */
export function isStaffUiAssetPath(pathname: string): boolean {
  return /^\/assets\/(?:AdminApp|StaffApp)-[^/]+\.js$/i.test(pathname);
}

export function isPublicAppPath(pathname: string): boolean {
  const path = normalizePublicPath(pathname);
  return PUBLIC_APP_PATHS.has(path) || path === "/auth" || path.startsWith("/auth/");
}

export function isPublicTextFilePath(pathname: string): boolean {
  const path = normalizePublicPath(pathname);
  return path === "/robots.txt" || path === "/sitemap.xml";
}

/** True when Workers Assets SPA-fallback returned the Vite shell instead of a real file. */
export function looksLikeSpaShell(html: string): boolean {
  return html.includes('id="root"') && html.includes("/assets/");
}

/** Paths that may be served without the site-access cookie. */
export function isSiteGatedPath(pathname: string): boolean {
  if (isStaffUiAssetPath(pathname)) return true;
  if (ALWAYS_OPEN_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))) {
    return false;
  }
  if (pathname.startsWith("/assets/")) return false;
  if (isPublicAppPath(pathname) || isPublicTextFilePath(pathname)) return false;
  if (COMING_SOON_PUBLIC_PATHS.has(pathname)) return false;
  return true;
}

export function handlePublicTextFiles(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = normalizePublicPath(new URL(request.url).pathname);
  if (path === "/robots.txt") {
    const body = [
      "User-agent: *",
      "Allow: /coming-soon",
      "Allow: /signin",
      "Allow: /terms",
      "Allow: /privacy",
      "Disallow: /admin",
      "Disallow: /staff",
      "Sitemap: https://www.replayr.tv/sitemap.xml",
      "",
    ].join("\n");
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (path === "/sitemap.xml") {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.replayr.tv/coming-soon</loc></url>
  <url><loc>https://www.replayr.tv/signin</loc></url>
  <url><loc>https://www.replayr.tv/terms</loc></url>
  <url><loc>https://www.replayr.tv/privacy</loc></url>
</urlset>
`;
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

export async function hasValidSiteAccess(request: Request, env: Env): Promise<boolean> {
  const password = env.SITE_ACCESS_PASSWORD?.trim();
  if (!password) {
    const host = new URL(request.url).hostname;
    if (host === "127.0.0.1" || host === "localhost") return true;
    return false;
  }
  const cookie = readCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  return verifyAccessToken(password, cookie);
}

export async function handleSiteAccess(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/site-access") {
    await assertDistributedRateLimit(request, env.SITE_ACCESS_RATE_LIMITER, "site-access", 10);
    const password = env.SITE_ACCESS_PASSWORD?.trim();
    if (!password) {
      return json({ error: "Site access is not configured." }, 503);
    }
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    const provided = String(body.password ?? "");
    if (!(await timingSafeEqual(provided, password))) {
      return json({ error: "Incorrect password." }, 401);
    }
    return await openedSiteResponse(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/site-access/session") {
    await assertDistributedRateLimit(request, env.SITE_ACCESS_RATE_LIMITER, "site-access", 10);
    await requireUser(request, env);
    return await openedSiteResponse(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/site-access/logout") {
    const host = new URL(request.url).hostname;
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    const domain =
      host === "replayr.tv" || host.endsWith(".replayr.tv") ? "; Domain=.replayr.tv" : "";
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=; Path=/${domain}; HttpOnly${secure}; SameSite=Lax; Max-Age=0`,
    );
    headers.append(
      "set-cookie",
      `${OPEN_COOKIE}=; Path=/${domain}${secure}; SameSite=Lax; Max-Age=0`,
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  return null;
}

async function openedSiteResponse(request: Request, env: Env): Promise<Response> {
  const password = env.SITE_ACCESS_PASSWORD?.trim() || "";
  const host = new URL(request.url).hostname;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  // Share links use apex replayr.tv; marketing often unlocks on www — one cookie for both.
  const domain = host === "replayr.tv" || host.endsWith(".replayr.tv") ? "; Domain=.replayr.tv" : "";
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (password) {
    const token = await mintAccessToken(password);
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=${token}; Path=/${domain}; HttpOnly${secure}; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`,
    );
  }
  headers.append(
    "set-cookie",
    `${OPEN_COOKIE}=1; Path=/${domain}${secure}; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`,
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function handleWaitlist(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/waitlist/unsubscribe") {
    return unsubscribeWaitlist(url, env);
  }
  if (!(request.method === "POST" && url.pathname === "/v1/waitlist")) return null;
  await assertDistributedRateLimit(request, env.WAITLIST_RATE_LIMITER, "waitlist", 10);

  const body = (await request.json().catch(() => ({}))) as { email?: string; source?: string };
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  if (!isValidEmail(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  requireServiceRole(env);
  let created: WaitlistEmailRow | null = null;
  try {
    const rows = await serviceRest<WaitlistEmailRow[]>(
      env,
      "POST",
      "/waitlist_emails",
      {
        email,
        source: String(body.source ?? "coming-soon").slice(0, 64),
      },
      "return=representation,resolution=ignore-duplicates",
    );
    created = Array.isArray(rows) ? rows[0] ?? null : null;
  } catch (caught) {
    if (caught instanceof HttpError && caught.status === 409) {
      return json({ ok: true });
    }
    const message = caught instanceof Error ? caught.message : "";
    if (/duplicate|unique|23505/i.test(message)) {
      return json({ ok: true });
    }
    throw new HttpError(502, "Could not save that email. Try again.");
  }
  if (!created) {
    return json({ ok: true });
  }

  const origin = publicSiteUrl(env.PUBLIC_APP_URL);
  const unsubscribeUrl = waitlistUnsubscribeUrl(origin, created.unsubscribe_token);
  const message = waitlistConfirmEmail({ siteUrl: origin, unsubscribeUrl });
  const delivery = await sendReplayrEmail(env, {
    to: created.email,
    ...message,
    idempotencyKey: `waitlist-confirm/${created.id}`,
  });
  if (delivery.sent) {
    await serviceRest(
      env,
      "PATCH",
      `/waitlist_emails?id=eq.${created.id}`,
      { confirmation_sent_at: new Date().toISOString() },
      "return=minimal",
    ).catch(() => undefined);
  }
  return json({ ok: true, delivery });
}

async function unsubscribeWaitlist(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token")?.trim() || "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return unsubscribePage("That unsubscribe link is invalid.", 400);
  }
  requireServiceRole(env);
  const rows = await serviceRest<WaitlistEmailRow[]>(
    env,
    "GET",
    `/waitlist_emails?unsubscribe_token=eq.${token}&select=id,unsubscribed_at`,
  );
  const row = rows[0];
  if (!row) {
    return unsubscribePage("That unsubscribe link is invalid.", 404);
  }
  if (!row.unsubscribed_at) {
    await serviceRest(
      env,
      "PATCH",
      `/waitlist_emails?id=eq.${row.id}`,
      { unsubscribed_at: new Date().toISOString() },
      "return=minimal",
    );
  }
  return unsubscribePage("You're off the Replayr waitlist. We won't email you again.");
}

function unsubscribePage(message: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Replayr waitlist</title></head>
     <body style="margin:0;background:#090b10;color:#f4f7fb;font-family:Inter,Arial,sans-serif">
       <div style="max-width:480px;margin:80px auto;padding:24px">
         <p style="color:#00d8f0;font-weight:800;letter-spacing:1.2px;text-transform:uppercase">Replayr</p>
         <h1 style="font-size:28px">Waitlist</h1>
         <p>${escapePage(message)}</p>
         <p><a href="https://replayr.tv" style="color:#00d8f0">replayr.tv</a></p>
       </div>
     </body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function escapePage(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type WaitlistEmailRow = {
  id: string;
  email: string;
  unsubscribe_token: string;
  unsubscribed_at?: string | null;
  confirmation_sent_at?: string | null;
};

/** Prefer the built asset; fall back to embedded HTML so the gate never goes blank. */
export async function serveComingSoon(request: Request, env: Env): Promise<Response> {
  if (env.ASSETS) {
    // Fetch by URL only — do not forward the original Request, or run_worker_first
    // can re-enter the gate and never reach the static file.
    const soon = new URL("/coming-soon.html", request.url);
    const asset = await env.ASSETS.fetch(soon.toString());
    if (asset.ok) {
      const text = await asset.text();
      // SPA fallback would look like the main app shell — reject that.
      if (text.includes("coming-soon.js") || text.includes("hero-logo")) {
        return comingSoonResponse(text, new URL(request.url).protocol === "https:");
      }
    }
  }
  return comingSoonResponse(comingSoonFallbackHtml(), new URL(request.url).protocol === "https:");
}

/** Paid-traffic waitlist URLs. `/waitlist` used to SPA-fallback to the download homepage. */
export async function handleWaitlistPages(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (isWaitlistAliasPath(url.pathname)) return waitlistAliasRedirect(url);
  if (isComingSoonPath(url.pathname)) return serveComingSoon(request, env);
  return null;
}

export function comingSoonSecurityHeaders(headers: Headers = new Headers(), https = false): Headers {
  headers.set("Content-Security-Policy", comingSoonContentSecurityPolicy());
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("cache-control", "no-store");
  if (https) headers.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  return headers;
}

function comingSoonResponse(html: string, https = false): Response {
  const headers = comingSoonSecurityHeaders(new Headers(), https);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function mintAccessToken(password: string): Promise<string> {
  const exp = Date.now() + COOKIE_MAX_AGE_SEC * 1000;
  const payload = `v1.${exp}`;
  const sig = await hmacHex(password, payload);
  return `${payload}.${sig}`;
}

async function verifyAccessToken(password: string, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts;
  if (version !== "v1") return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const payload = `${version}.${expRaw}`;
  const expected = await hmacHex(password, payload);
  return timingSafeEqual(sig, expected);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.byteLength !== right.byteLength) {
    await hmacHex(a || "x", b || "y");
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** Embedded copy of the beta hero — keeps the gate working if assets miss. */
export function comingSoonFallbackHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Replayr — Your best plays, already captured</title>
    <meta name="description" content="Replayr keeps the last few minutes of your game ready. One hotkey saves what just happened. Join the beta. Windows app available, free at launch." />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="https://replayr.tv/coming-soon" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <style>
      :root{color-scheme:dark;--bg:#101415;--ink:#f5f7f4;--mint:#76f8de;--muted:#a8b0ae}
      *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg)}
      body{background:radial-gradient(58% 78% at 86% 18%,rgba(47,107,98,.45),transparent 68%),var(--bg)}
      a{color:inherit;text-decoration:none}.wrap{width:min(720px,calc(100% - 40px));margin:0 auto;padding:48px 0 32px}
      .kicker{display:flex;align-items:center;gap:10px;letter-spacing:.16em;font-size:.72rem;font-weight:650;color:rgba(245,247,244,.72)}
      .mark{width:8px;height:8px;background:var(--mint)}
      h1{margin:18px 0;font-size:clamp(2.6rem,8vw,4.4rem);line-height:.9;letter-spacing:-.04em}
      .mint{color:var(--mint)}
      .lede,.trust{color:var(--muted);line-height:1.5}.trust{font-size:.88rem}
      .waitlist,.gate{display:flex;flex-wrap:wrap;gap:10px;max-width:460px;margin-top:18px}
      .gate{display:none}.gate.is-open{display:flex}
      .waitlist input,.gate input{flex:1 1 180px;min-width:0;height:48px;border-radius:10px;border:1px solid #303636;background:#202626;color:var(--ink);padding:0 16px}
      .waitlist button,.gate button{border:0;border-radius:10px;background:var(--mint);color:#0c1614;font-weight:700;height:48px;padding:0 16px;cursor:pointer}
      .waitlist.is-done{display:none}
      .confirm{display:none;margin-top:14px;padding:14px 16px;border-radius:12px;border:1px solid rgba(118,248,222,.35)}
      .confirm.is-open{display:block}.confirm strong{color:var(--mint)}
      .pipeline{margin-top:36px;letter-spacing:.16em;font-size:.68rem;color:rgba(245,247,244,.45)}
      .access-link{border:0;background:transparent;color:rgba(245,247,244,.45);font:inherit;cursor:pointer;padding:0}
      footer{display:flex;flex-wrap:wrap;gap:12px 16px;margin-top:12px;color:rgba(245,247,244,.38);font-size:.78rem}
    </style>
  </head>
  <body>
    <div class="wrap">
      <p class="kicker"><span class="mark"></span>GAMEPLAY HAPPENS ONCE. KEEP IT.</p>
      <h1>YOUR BEST PLAYS,<br>ALREADY<br><span class="mint">CAPTURED.</span></h1>
      <p class="lede">Replayr keeps the last few minutes of your game ready. Something incredible happens? One hotkey saves what just happened.</p>
      <div class="signup">
        <form class="waitlist" id="waitlist" autocomplete="on">
          <input type="email" name="email" required placeholder="Your email address" aria-label="Email" autocomplete="email" />
          <button type="submit">Join the beta</button>
        </form>
        <div class="confirm" id="waitConfirm" role="status">
          <strong>You're on the list.</strong>
          <p>Thanks — we'll email you when beta opens.</p>
        </div>
        <p class="msg" id="waitMsg" role="status"></p>
        <p class="trust">No spam. Just launch updates and early access.</p>
        <p class="trust">Windows app available · Free at launch</p>
      </div>
      <p class="pipeline">CAPTURE — KEEP — EDIT — SHARE — RELIVE</p>
      <footer>
        <a class="access-link" href="/signin">Log in</a>
        <button type="button" class="access-link" id="unlockToggle">Already have access?</button>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
        <form class="gate" id="gate" hidden autocomplete="current-password">
          <input type="password" name="password" required placeholder="Access password" aria-label="Access password" />
          <button type="submit">Enter site</button>
        </form>
        <p class="msg" id="gateMsg" role="status"></p>
      </footer>
    </div>
    <script src="/coming-soon.js" defer></script>
  </body>
</html>`;
}
