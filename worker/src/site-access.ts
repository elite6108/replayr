import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireServiceRole, serviceRest } from "./shared";
import { publicSiteUrl, sendReplayrEmail, waitlistConfirmEmail, waitlistUnsubscribeUrl } from "./email";

const COOKIE_NAME = "replayr_site_access";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

const ALWAYS_OPEN_PREFIXES = [
  "/v1/",
  "/internal/",
  "/releases/",
  "/c/",
  "/clip/",
  "/f/",
  "/s/",
  "/assets/",
  "/auth/",
  "/signin/",
  "/staff/",
  "/.well-known/",
];

/** Desktop/web OAuth returns must stay reachable without the site-access cookie. */
export function isOAuthHandoff(url: URL): boolean {
  if (url.pathname === "/auth/desktop" || url.pathname === "/auth/callback" || url.pathname.startsWith("/auth/")) {
    return true;
  }
  return url.searchParams.has("code");
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
  "/replayr-logo.png",
  "/replayr-mark.png",
  "/favicon.png",
  "/apple-touch-icon.png",
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

/** Paths that may be served without the site-access cookie (static coming-soon). */
export function isSiteGatedPath(pathname: string): boolean {
  if (ALWAYS_OPEN_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))) {
    return false;
  }
  if (COMING_SOON_PUBLIC_PATHS.has(pathname)) return false;
  if (/\.(js|css|map|png|jpe?g|webp|svg|ico|woff2?|ttf|txt|json)$/i.test(pathname)) {
    return false;
  }
  return true;
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
    const password = env.SITE_ACCESS_PASSWORD?.trim();
    if (!password) {
      return json({ error: "Site access is not configured." }, 503);
    }
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    const provided = String(body.password ?? "");
    if (!(await timingSafeEqual(provided, password))) {
      return json({ error: "Incorrect password." }, 401);
    }
    const token = await mintAccessToken(password);
    const host = new URL(request.url).hostname;
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    // Share links use apex replayr.tv; marketing often unlocks on www — one cookie for both.
    const domain =
      host === "replayr.tv" || host.endsWith(".replayr.tv") ? "; Domain=.replayr.tv" : "";
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=${token}; Path=/${domain}; HttpOnly${secure}; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`,
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
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
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  return null;
}

export async function handleWaitlist(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/waitlist/unsubscribe") {
    return unsubscribeWaitlist(url, env);
  }
  if (!(request.method === "POST" && url.pathname === "/v1/waitlist")) return null;

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
        return comingSoonResponse(text);
      }
    }
  }
  return comingSoonResponse(comingSoonFallbackHtml());
}

/** Paid-traffic waitlist URLs. `/waitlist` used to SPA-fallback to the download homepage. */
export async function handleWaitlistPages(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (isWaitlistAliasPath(url.pathname)) return waitlistAliasRedirect(url);
  if (isComingSoonPath(url.pathname)) return serveComingSoon(request, env);
  return null;
}

export function comingSoonSecurityHeaders(headers: Headers = new Headers()): Headers {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self'",
    "connect-src 'self' https://replayr.tv https://www.replayr.tv",
    "form-action 'self'",
  ].join("; ");
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("cache-control", "no-store");
  return headers;
}

function comingSoonResponse(html: string): Response {
  const headers = comingSoonSecurityHeaders();
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

/** Embedded copy of web/public/coming-soon.html — keeps the gate working if assets miss. */
export function comingSoonFallbackHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Replayr — Beta waitlist</title>
    <meta name="description" content="Join the Replayr beta waitlist. Instant Replay clips stay on your PC. Early emails get access when beta opens." />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="https://replayr.tv/coming-soon" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <style>
      :root{color-scheme:dark;--bg:#07080d;--text:#f3f5f8;--muted:#9aa3b2;--accent:#7fd0ef;--accent-strong:#4bb8e0;--ok:#8ed9a4;--border:rgba(255,255,255,.08);--font:"Outfit","Segoe UI",system-ui,sans-serif}
      *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:var(--font);color:var(--text);background:var(--bg)}
      a{color:var(--accent);text-decoration:none}.wrap{width:min(1120px,calc(100% - 32px));margin:0 auto}
      header{padding:18px 0 4px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
      .hero{padding:28px 0 36px}
      .eyebrow{margin:0 0 10px;color:var(--accent);font-size:.82rem;font-weight:650;letter-spacing:.06em;text-transform:uppercase}
      h1{margin:0 0 12px;font-size:clamp(1.85rem,7.4vw,3.6rem);line-height:1.04}
      .lede,.offer,.trust,.price-teaser{margin:0 0 14px;color:var(--muted);line-height:1.5}
      .offer,.price-teaser{color:var(--text)}.trust{font-size:.88rem}
      .waitlist,.gate{display:flex;flex-wrap:wrap;gap:10px;max-width:480px}
      .gate{display:none;margin-top:12px}.gate.is-open{display:flex}
      .waitlist input,.gate input{flex:1 1 220px;min-width:0;border-radius:999px;border:1px solid var(--border);background:#0a0c12;color:var(--text);font:inherit;padding:13px 18px}
      .waitlist button,.gate button,.header-cta{border:0;border-radius:999px;background:var(--accent-strong);color:#061018;font:inherit;font-weight:650;padding:13px 20px;cursor:pointer}
      .header-cta{display:inline-flex;text-decoration:none;padding:9px 16px;font-size:.9rem}
      .waitlist.is-done{display:none}
      .confirm{display:none;max-width:480px;padding:16px 18px;border-radius:18px;border:1px solid rgba(142,217,164,.28)}
      .confirm.is-open{display:block}.confirm strong{color:var(--ok)}
      .shot{margin:28px 0 0;border-radius:22px;overflow:hidden;border:1px solid var(--border)}
      .shot img{display:block;width:100%;height:auto}
      .plan .price{color:var(--accent);font-weight:650}
      .access-link{border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer;padding:0}
      footer{padding:24px 0 40px;color:var(--muted);border-top:1px solid var(--border)}
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <a href="/coming-soon" aria-label="Replayr"><img src="/replayr-logo.png" alt="Replayr" width="140" height="32" /></a>
        <a class="header-follow" href="https://x.com/Replayr_TV">Follow us</a>
        <a class="header-cta" href="#waitlist-cta">Join waitlist</a>
      </header>
      <section class="hero">
        <p class="eyebrow">Beta waitlist</p>
        <h1>Your best plays, already captured.</h1>
        <p class="lede">Replayr keeps a rolling buffer so the clutch is already on disk. Save locally, upload when you want, and share only when you hit send.</p>
        <p class="offer">Early emails get beta access when it opens.</p>
        <form class="waitlist" id="waitlist" autocomplete="on">
          <input type="email" name="email" required placeholder="you@email.com" aria-label="Email" autocomplete="email" />
          <button type="submit">Join the beta waitlist</button>
        </form>
        <div class="confirm" id="waitConfirm" role="status">
          <strong>You're on the list.</strong>
          <p>Thanks — we'll email you when beta opens.</p>
        </div>
        <p class="msg" id="waitMsg" role="status"></p>
        <p class="trust">No spam. We'll only email you when beta opens.</p>
        <p class="price-teaser">Free to start · Premium $6.99/mo</p>
        <figure class="shot">
          <img src="/instant-replay.png" alt="Replayr Instant Replay workspace with clip buffer and sources" width="1600" height="1000" />
        </figure>
      </section>
      <section class="cta-band" id="waitlist-cta">
        <h2>Get in before beta opens</h2>
        <form class="waitlist" id="waitlist-cta-form" autocomplete="on">
          <input type="email" name="email" required placeholder="you@email.com" aria-label="Email" autocomplete="email" />
          <button type="submit">Join the beta waitlist</button>
        </form>
      </section>
      <section class="pricing" aria-label="Pricing">
        <div class="plan"><strong>Free</strong><div class="price">$0</div></div>
        <div class="plan"><strong>Premium</strong><div class="price">$6.99/mo</div></div>
      </section>
      <footer>
        <span>© Replayr</span>
        <button type="button" class="access-link" id="unlockToggle">Already have access?</button>
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
