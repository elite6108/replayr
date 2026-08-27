import type { Env } from "./env";
import { HttpError, json } from "./http";
import { requireServiceRole, serviceRest } from "./shared";

const COOKIE_NAME = "replayr_site_access";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

const ALWAYS_OPEN_PREFIXES = ["/v1/", "/internal/", "/releases/", "/c/", "/assets/"];

/** Static files the locked coming-soon page needs (must stay ungated). */
export const COMING_SOON_PUBLIC_PATHS = new Set([
  "/coming-soon.html",
  "/coming-soon.js",
  "/replayr-logo.png",
  "/replayr-mark.png",
  "/favicon.png",
  "/apple-touch-icon.png",
]);

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
  if (!(request.method === "POST" && url.pathname === "/v1/waitlist")) return null;

  const body = (await request.json().catch(() => ({}))) as { email?: string; source?: string };
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  if (!isValidEmail(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  requireServiceRole(env);
  try {
    await serviceRest(
      env,
      "POST",
      "/waitlist_emails",
      {
        email,
        source: String(body.source ?? "coming-soon").slice(0, 64),
      },
      "return=minimal,resolution=ignore-duplicates",
    );
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
  return json({ ok: true });
}

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
  return comingSoonResponse(comingSoonHtml());
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
function comingSoonHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Replayr — Coming soon</title>
    <meta name="description" content="Replayr is almost here. Capture every clutch play with Instant Replay, keep clips on your PC, and share when you're ready." />
    <meta name="robots" content="index,follow" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Sora:wght@500;600&display=swap" rel="stylesheet" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <style>
      :root{color-scheme:dark;--bg:#07080d;--text:#f3f5f8;--muted:#9aa3b2;--accent:#7fd0ef;--accent-strong:#4bb8e0;--ok:#8ed9a4;--border:rgba(255,255,255,.08);--font:"Outfit","Segoe UI",system-ui,sans-serif;--display:"Sora","Outfit",system-ui,sans-serif}
      *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:var(--font);color:var(--text);background:radial-gradient(1100px 640px at 12% -18%,rgba(79,184,224,.28),transparent 55%),radial-gradient(820px 520px at 100% 0%,rgba(111,208,138,.1),transparent 50%),var(--bg)}
      a{color:var(--accent);text-decoration:none}.wrap{width:min(1080px,calc(100% - 32px));margin:0 auto}
      .brand{display:inline-flex;align-items:center;line-height:0}
      .brand img{height:28px;width:auto;object-fit:contain}
      header{padding:28px 0 8px;display:flex;align-items:center;justify-content:space-between;gap:16px}
      .access-link{border:0;background:transparent;color:var(--muted);font:inherit;cursor:pointer;padding:0}
      .access-link:hover{color:var(--text)}
      .hero{padding:56px 0 48px;max-width:760px}
      .hero-logo{width:min(220px,56vw);height:auto;display:block;margin:0 0 22px;filter:drop-shadow(0 18px 40px rgba(0,0,0,.35))}
      .hero h1{margin:0 0 16px;font-family:var(--display);font-size:clamp(2.6rem,7vw,4.4rem);line-height:1.02;letter-spacing:-.04em;font-weight:600}
      .hero .lede{margin:0 0 28px;color:var(--muted);font-size:1.14rem;line-height:1.55;max-width:36rem}
      .waitlist,.gate{display:flex;flex-wrap:wrap;gap:10px;max-width:480px}
      .gate{display:none;margin-top:18px;max-width:420px}
      .gate.is-open{display:flex}
      .waitlist input,.gate input{flex:1 1 220px;min-width:0;border-radius:999px;border:1px solid var(--border);background:rgba(10,12,18,.78);color:var(--text);font:inherit;padding:14px 18px;outline:none}
      .waitlist button,.gate button{border:0;border-radius:999px;background:linear-gradient(180deg,#9adcf3,var(--accent-strong));color:#061018;font:inherit;font-weight:650;padding:14px 22px;cursor:pointer}
      .msg{min-height:1.4em;margin:12px 0 0;color:var(--muted);font-size:.95rem}.msg.ok{color:var(--ok)}.msg.err{color:#ff9b9b}
      .features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;padding:28px 0 64px;border-top:1px solid var(--border)}
      .features article h2{margin:0 0 8px;font-size:1.05rem;font-weight:600}.features article p{margin:0;color:var(--muted);line-height:1.5;font-size:.95rem}
      .pricing{padding:8px 0 80px;border-top:1px solid var(--border)}.pricing h2{margin:28px 0 8px;font-family:var(--display);font-size:1.6rem}.pricing>p{margin:0 0 22px;color:var(--muted)}
      .plans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.plan{padding:22px;border:1px solid var(--border);border-radius:22px;background:rgba(16,19,27,.55)}.plan strong{display:block;font-size:1.15rem;margin-bottom:4px}.plan .price{color:var(--accent);font-weight:650;margin-bottom:14px}.plan ul{margin:0;padding-left:1.1rem;color:var(--muted);line-height:1.55}
      footer{padding:24px 0 40px;color:var(--muted);font-size:.9rem;border-top:1px solid var(--border)}
      @media (max-width:820px){.features,.plans{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <a class="brand" href="/" aria-label="Replayr"><img src="/replayr-logo.png" alt="Replayr" width="140" height="32" /></a>
        <button type="button" class="access-link" id="unlockToggle">Already have access?</button>
      </header>
      <section class="hero">
        <img class="hero-logo" src="/replayr-logo.png" alt="Replayr" width="220" height="64" />
        <h1>Your best plays, already captured.</h1>
        <p class="lede">The clutch happened. Replayr already had it. Instant Replay on Windows, clips that stay on your PC, and share links that stay quiet until you hit send. Drop your email — be first when we go live.</p>
        <form class="waitlist" id="waitlist" autocomplete="on">
          <input type="email" name="email" required placeholder="you@email.com" aria-label="Email" />
          <button type="submit">Notify me</button>
        </form>
        <p class="msg" id="waitMsg" role="status"></p>
        <form class="gate" id="gate" hidden autocomplete="current-password">
          <input type="password" name="password" required placeholder="Access password" aria-label="Access password" />
          <button type="submit">Enter site</button>
        </form>
        <p class="msg" id="gateMsg" role="status"></p>
      </section>
      <section class="features" aria-label="Features">
        <article><h2>Instant Replay</h2><p>The last seconds are already in the buffer. One hotkey saves the moment without stopping the game.</p></article>
        <article><h2>Local first</h2><p>Clips live on this PC. Upload and share only when you choose — private, unlisted, or public.</p></article>
        <article><h2>Webcam overlay</h2><p>Optional face cam over gameplay, editable placement, and branded free-tier downloads when you share.</p></article>
      </section>
      <section class="pricing" aria-label="Pricing">
        <h2>Pricing</h2>
        <p>Simple plans. Waitlist only for now — no download or signup on this page.</p>
        <div class="plans">
          <div class="plan"><strong>Free</strong><div class="price">$0</div><ul><li>5 GB cloud storage</li><li>Up to 20‑minute 1080p uploads</li><li>Watermarked downloads</li><li>House ads on free viewing</li></ul></div>
          <div class="plan"><strong>Premium</strong><div class="price">$4.99/mo · $47.88/yr</div><ul><li>100 GB cloud storage</li><li>Original / 4K uploads</li><li>No watermark on downloads</li><li>7‑day trial when we open</li></ul></div>
        </div>
      </section>
      <footer>© Replayr · Windows gameplay clipper</footer>
    </div>
    <script src="/coming-soon.js" defer></script>
  </body>
</html>`;
}
