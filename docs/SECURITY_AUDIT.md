# Replayr security audit

**Date:** 2026-09-13  
**Scope:** Static review of this repository (`main` at audit time), including desktop (`src/`, `src-tauri/`), website (`web/`), Cloudflare Worker (`worker/`), Supabase migrations (`supabase/`), mobile (`mobile/`), CI, and config.  
**Method:** Read-only source review. No live production probing, no exploit proofs of concept, no attack scripts.  
**Overall posture:** **Medium.** Cloud authorization and RLS are unusually mature for this stage. The remaining risk is concentrated in desktop IPC trust, a public-folder visibility gap, operational rate limiting, and standard web token storage.

This report is written for owners who need a prioritized fix list. It does not implement remediations.

---

## Executive summary

Replayr is a gaming capture and social platform split across a Tauri 2 desktop clipper, a Vite website, an Expo mobile client, a Cloudflare Worker BFF, Supabase Auth/Postgres, and Cloudflare R2. Privileged writes are intended to live in the Worker (service role). Clients hold only the Supabase anon key. That split is real in this codebase and is the strongest control in the system.

**What is in good shape**

- Unlisted clips are excluded from PostgREST listing and from Explore (`visibility=eq.public`).
- R2 object keys are server-minted (`clips/{user_id}/{clip_id}/original.mp4`). Clients cannot choose paths.
- Folder roles (Owner / Manager / Editor / Viewer) are enforced in the Worker, not only in the UI.
- Admin APIs require `app_metadata.role === "admin"` (not `user_metadata`).
- No live service-role, R2, Stripe, or Bunny secrets are committed.
- Webhooks (Stripe, Bunny) verify HMAC signatures.
- Desktop Windows sessions are DPAPI-protected. Mobile native sessions use Expo SecureStore.

**What needs attention before a broad public launch**

1. Public folder links (`/f/{token}`) play and list **private** clips if the owner added them.
2. Several Tauri commands trust frontend-supplied URLs or file paths. A compromised WebView becomes a token-exfil or local-file primitive.
3. Worker rate limits are in-memory per isolate. `/v1/site-access` and `/v1/waitlist` have no limit.
4. Upload complete checks size, not that the object is actually an MP4.
5. Web JWTs live in `localStorage`. macOS/Linux desktop sessions are stored as plaintext files.

No **Critical** finding (unauthenticated data dump, committed production secrets, or client-held service role) was identified. The highest issues are **High**.

---

## Scope and methodology

### In scope

| System | Paths reviewed |
| --- | --- |
| Architecture and operator docs | `docs/ARCHITECTURE.md`, `README.md`, `docs/analytics-metrics.md` |
| Desktop UI | `src/` (auth store, API clients, folder/editor pages) |
| Desktop native | `src-tauri/` (commands, capabilities, CSP, updater, upload, share, auth, paths) |
| Website | `web/` (auth, clip player, social, admin UI, SEO) |
| Mobile | `mobile/` (session storage, deep links, env) |
| Worker / API | `worker/src/` (auth, clips, folders, social, billing, admin, site gate, R2) |
| Database | `supabase/migrations/` (RLS, grants, triggers, RPCs) |
| CI / secrets | `.github/workflows/macos-dmg.yml`, `.env.example`, `.env.production`, `worker/wrangler.toml`, `.gitignore` |
| Dependencies | `package.json` / lockfiles (root, web, worker, mobile), `src-tauri/Cargo.toml` |

### Out of scope / assumptions

- Production Cloudflare, Supabase, R2, Stripe, and Bunny **dashboard** settings were not inspected. Migrations are assumed applied.
- How `app_metadata.role = "admin"` is assigned is assumed to be a manual service-role operation.
- R2 bucket public-access settings and Cloudflare WAF/rate-limit rules are not in-repo.
- Supabase Auth settings (JWT expiry, refresh rotation, email confirmation, redirect allowlist) live in the dashboard.
- No dynamic XSS, updater MITM, or OAuth interception testing was performed.
- Live secret values in Wrangler / GitHub Environments were not read.

### Severity scale

| Severity | Meaning |
| --- | --- |
| Critical | Unauthenticated or trivial compromise of all user data, or committed production secrets |
| High | Unauthorized access to another user's private media/account, or a reliable privilege step after a common foothold |
| Medium | Meaningful hardening gap; realistic abuse or privacy leak under plausible conditions |
| Low | Limited impact, short window, or defense-in-depth |
| Informational | Correct-by-design note, operational hygiene, or residual risk that is acceptable |

---

## Architecture and trust boundaries

```
Desktop WebView / Web / Mobile
        │  anon key + user JWT
        ▼
   Supabase Auth  ── JWT ──►  Cloudflare Worker (service role)
        │                              │
        │  RLS SELECT only             ├── Postgres (privileged writes)
        ▼                              └── R2 (mint keys, HEAD, delete)
   Postgres (public + owner rows)           ▲
                                            │ short-lived SigV4 PUT
                                       Desktop / clients
```

| Boundary | Who is trusted | What must not be trusted |
| --- | --- | --- |
| React / Expo UI | Nothing for authorization | Ownership, file size, MIME, R2 keys, folder role claims |
| Tauri WebView | Same as any XSS surface | Paths, `api_base`, opener URLs, auth storage keys |
| Rust core | OS user on the machine | Frontend-supplied filesystem paths and remote URLs |
| Worker | Valid Supabase JWT (or webhook HMAC) | Client clip IDs without membership/ownership checks |
| Supabase PostgREST | RLS + column grants | Anything the Worker already decided (service role bypasses RLS) |
| R2 | Worker-minted keys and signed URLs | Client-chosen object keys |
| Public `/c/{slug}` | Slug knowledge = unlisted capability | Treating unlisted as “secret from the internet” |

The Worker uses `serviceRest()` (`worker/src/shared.ts`) with `SUPABASE_SERVICE_ROLE_KEY` for almost all database writes. That is intentional. **Every new Worker route must implement authorization in application code.** RLS will not save a missing `user_id` or membership check.

---

## Findings table

| ID | Severity | Title | Location |
| --- | --- | --- | --- |
| R-01 | High | Public folder links ignore clip visibility (private leak) | `worker/src/folderPublic.ts`, `worker/src/folders.ts` |
| R-02 | High | Desktop upload/delete send the JWT to a caller-supplied API base | `src-tauri/src/upload.rs`, `src-tauri/src/commands.rs` |
| R-03 | High | Share/export accept an arbitrary source path when `local_id` is omitted | `src-tauri/src/share.rs`, `src-tauri/src/commands.rs` |
| R-04 | Medium | macOS/Linux desktop sessions stored as plaintext | `src-tauri/src/auth.rs` |
| R-05 | Medium | `download_url_to_file` follows redirects after a weak scheme check | `src-tauri/src/upload.rs` |
| R-06 | Medium | Rate limits are per-isolate; site-access and waitlist are unlimited | `worker/src/rateLimit.ts`, `worker/src/site-access.ts` |
| R-07 | Medium | Coming-soon gate bypass via any `?code=` query | `worker/src/site-access.ts` |
| R-08 | Medium | Upload complete does not verify the object is an MP4 | `worker/src/index.ts` |
| R-09 | Medium | Desktop CSP and asset protocol are overly broad | `src-tauri/tauri.conf.json` |
| R-10 | Medium | Website persists the Supabase session in `localStorage` | `web/src/lib/supabase.ts` |
| R-11 | Medium | Some clip route IDs are interpolated into PostgREST URLs without UUID validation | `worker/src/index.ts` |
| R-12 | Medium | Unauthenticated error and analytics ingest can be abused | `worker/src/errors.ts`, `worker/src/analytics.ts` |
| R-13 | Medium | Announcement CTAs allow `http:` URLs | `worker/src/announcements.ts` |
| R-14 | Medium | Export destination allowlist has a string-prefix fallback | `src-tauri/src/paths.rs` |
| R-15 | Low | Worker JWT introspection cache (45s) | `worker/src/shared.ts` |
| R-16 | Low | Overlay window granted `core:default` | `src-tauri/capabilities/overlay.json` |
| R-17 | Low | Generic `auth_get_item` / `auth_set_item` IPC | `src-tauri/src/commands.rs`, `src-tauri/src/auth.rs` |
| R-18 | Low | Unlisted clip titles written into client-side OG/title tags | `web/src/pages/ClipPage.tsx` |
| R-19 | Low | Fallback clip HTML missing CSP headers | `worker/src/index.ts` |
| R-20 | Low | `opener:default` and unconstrained `save_location` | `src-tauri/capabilities/default.json`, `src-tauri/src/capture.rs` |
| R-21 | Low | Thumbnail PUT has no post-upload content check | `worker/src/index.ts` |
| R-22 | Low | Group chats: any member can add others | `worker/src/social.ts` |
| R-23 | Low | `/v1/health` discloses whether R2 is configured | `worker/src/index.ts` |
| R-24 | Informational | Share slugs are random (~50 bits), not sequential | `worker/src/index.ts` |
| R-25 | Informational | `wrangler.toml` defaults `PUBLIC_APP_URL` to localhost | `worker/wrangler.toml` |
| R-26 | Informational | No `SECURITY.md` / vulnerability-reporting contact | repo root |

---

## Findings

### R-01 — Public folder links ignore clip visibility

| | |
| --- | --- |
| **Severity** | High |
| **Likelihood** | Medium (owner enables a public folder link; private clips already in the folder) |
| **Location** | `worker/src/folders.ts` (`addFolderClips`), `worker/src/folderPublic.ts` (`presentPublicFolder`, `signPublicFolderMedia`) |

**Description.** Adding clips to a folder requires that they belong to the caller and are `status=ready`. Visibility is not checked. Public folder listing and playback then load any ready clip in the folder:

```398:401:worker/src/folders.ts
  const clips = await serviceRest<ClipRow[]>(
    env,
    "GET",
    `/clips?id=in.(${clipIds.join(",")})&user_id=eq.${user.id}&status=eq.ready&select=${CLIP_SELECT}`,
```

```300:319:worker/src/folderPublic.ts
        `/clips?id=in.(${clipIds.join(",")})&status=eq.ready&select=${CLIP_MEDIA_SELECT}`,
      )
    : [];
  // ...
      thumbnailUrl: await signedOwnedUrl(env, clip.user_id, clip.thumbnail_key, "GET", undefined, PUBLIC_PLAYBACK_TTL),
```

`signPublicFolderMedia` likewise filters `status=eq.ready` only. Anyone with `/f/{token}` can list titles/thumbnails and obtain a signed GET for **private** clips.

**Impact.** A “private” clip is no longer owner-only. This contradicts the product rule that private is owner-only and that unlisted must not appear in public listings. A public folder **is** a public listing.

**Remediation.**

- Reject `visibility = 'private'` in `presentPublicFolder` and `signPublicFolderMedia`.
- Decide explicitly for unlisted: either exclude them from public folders, or treat the folder token as an additional unlisted capability and warn in the UI before enabling the link.
- When enabling a public link, refuse or confirm if the folder contains non-public clips.

---

### R-02 — Desktop upload/delete send the JWT to a caller-supplied API base

| | |
| --- | --- |
| **Severity** | High |
| **Likelihood** | Low unless the WebView is compromised (XSS, malicious dependency, abused DevTools) |
| **Location** | `src-tauri/src/upload.rs`, `src-tauri/src/commands.rs` |

**Description.** `upload_local_clip` and `delete_cloud_clip` take `api_base` from the frontend. Rust only rejects an empty value or a string containing `replay.example`:

```81:86:src-tauri/src/upload.rs
    let api_base = api_base.trim_end_matches('/');
    if api_base.is_empty() || api_base.contains("replay.example") {
        return Err(AppError::Message(
            "Cloud API URL is not set. Deploy the Worker and set VITE_PUBLIC_APP_URL.".into(),
        ));
    }
```

The native HTTP client then sends `Authorization: Bearer <access_token>` to that host. This bypasses the WebView CSP/`connect-src` allowlist.

**Impact.** After WebView compromise, the attacker can exfiltrate a live session to an arbitrary host using a first-party native request. That is a step beyond `fetch()` from JS (which is already broad because desktop CSP allows `connect-src … https:` — see R-09).

**Remediation.** Do not accept `api_base` from the frontend. Bake the Worker origin at build time (`https://www.replayr.tv` plus a localhost allowlist in debug builds). Reject anything else.

---

### R-03 — Share/export accept an arbitrary source path when `local_id` is omitted

| | |
| --- | --- |
| **Severity** | High |
| **Likelihood** | Low without WebView compromise; High with it |
| **Location** | `src-tauri/src/share.rs`, `src-tauri/src/commands.rs` |

**Description.** `reveal_local_clip` calls `assert_reveal_allowed`. `share_local_clip` and `export_local_clip` do not, when the caller passes `file_path` / `source` instead of `local_id`:

```34:57:src-tauri/src/share.rs
    let clip = if let Some(id) = local_id { ... } else { None };
    let gameplay = clip
        .as_ref()
        .map(|item| PathBuf::from(&item.file_path))
        .or_else(|| file_path.map(PathBuf::from))
        ...
    if !gameplay.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }
```

Any existing file the process can read can be handed to the OS share sheet, clipboard file-drop, or copied to an export destination.

**Impact.** Local credential files, documents, or other users’ media on the same account can leave the machine.

**Remediation.** Require a trusted `local_id` from SQLite (or otherwise resolve the source from a recorded clip row) before any read. Do **not** treat `assert_reveal_allowed` as sufficient: `reveal_roots` includes the entire app-data directory, Downloads, Videos, and the configurable save root (`src-tauri/src/paths.rs`). A path under app data still passes, including the plaintext non-Windows session files in R-04.

---

### R-04 — macOS/Linux desktop sessions stored as plaintext

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Medium on a shared Mac; malware with filesystem read is enough |
| **Location** | `src-tauri/src/auth.rs` |

**Description.** Windows uses DPAPI (`CryptProtectData`). Non-Windows `protect` / `unprotect` are identity functions:

```154:161:src-tauri/src/auth.rs
#[cfg(not(windows))]
fn protect(bytes: &[u8]) -> AppResult<Vec<u8>> {
    Ok(bytes.to_vec())
}
```

The session JSON (refresh token included) is written under the app data `auth/` directory. macOS Keychain is used only as a migration path.

**Impact.** Anyone with read access to the user’s app-data directory can replay the session.

**Remediation.** Encrypt with the OS keychain (or a key stored in Keychain/Secret Service) on macOS and Linux. Keep the file as a blob; do not leave the refresh token in plaintext.

---

### R-05 — `download_url_to_file` follows redirects after a weak scheme check

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Low (requires IPC invoke with a crafted URL) |
| **Location** | `src-tauri/src/upload.rs` |

**Description.** The command allows `https://`, `http://127.0.0.1`, and `http://localhost`, then follows up to 10 redirects without re-checking the hop:

```857:880:src-tauri/src/upload.rs
    if !url.starts_with("https://")
        && !url.starts_with("http://127.0.0.1")
        && !url.starts_with("http://localhost")
    {
        return Err(AppError::Message("Download URL is not allowed.".into()));
    }
    // ...
        .redirect(reqwest::redirect::Policy::limited(10))
```

An optional Bearer token is forwarded on the request.

**Impact.** The native client can be pointed at an attacker-controlled HTTPS URL that redirects to an internal service, or can attach the user’s JWT to a host that was not the original URL. There is an MP4 `ftyp` check after download (good), so the written file is less useful as HTML, but the request itself is the issue.

**Remediation.** Allowlist download hosts (`www.replayr.tv`, R2/Bunny hosts). Disable redirects, or validate every hop. Never attach the Bearer token unless the final host is the Worker origin.

---

### R-06 — Rate limits are per-isolate; site-access and waitlist are unlimited

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | High for password guessing and waitlist spam if the coming-soon gate stays on |
| **Location** | `worker/src/rateLimit.ts`, `worker/src/site-access.ts` |

**Description.** `allowRateLimit` stores timestamps in a process `Map`. Cloudflare isolates and cold starts do not share that map. Several public endpoints have **no** call to `assertRateLimit`:

- `POST /v1/site-access` (shared password, timing-safe compare — good — but unlimited attempts)
- `POST /v1/waitlist` (validated email, no throttle)

Upload, playback, social writes, public folders, and error ingest do have in-memory limits.

**Impact.** The coming-soon password can be guessed offline-from-the-gate. The waitlist table can be filled with junk. Authenticated abuse (upload spam, comment spam) is only partially contained.

**Remediation.** Use Cloudflare Rate Limiting rules or a Durable Object / KV counter for `/v1/site-access`, `/v1/waitlist`, `/v1/errors`, `/v1/analytics/events`, and upload-create. Keep the in-memory limiter as a first line only.

---

### R-07 — Coming-soon gate bypass via any `?code=` query

| | |
| --- | --- |
| **Severity** | Medium (pre-launch marketing gate only) |
| **Likelihood** | High if the gate is still on at launch marketing time |
| **Location** | `worker/src/site-access.ts` |

**Description.**

```21:26:worker/src/site-access.ts
export function isOAuthHandoff(url: URL): boolean {
  if (url.pathname === "/auth/desktop" || url.pathname === "/auth/callback" || url.pathname.startsWith("/auth/")) {
    return true;
  }
  return url.searchParams.has("code");
}
```

Any gated path with `?code=` is treated as an OAuth return and serves the full SPA. `/auth/*`, `/c/`, `/f/`, `/v1/`, and `/releases/` are already always-open by design.

**Impact.** The password gate is not a security boundary for the API (intentional). It **is** the boundary for Explore, account, and admin UI chrome. This bypass removes that chrome lock.

**Remediation.** Restrict the `code` exception to `/` and `/auth/*`.

Do **not** “turn the gate off” by unsetting `SITE_ACCESS_PASSWORD`. `hasValidSiteAccess` returns `false` for every non-localhost request when the password is absent (`worker/src/site-access.ts`), so production stays locked on the coming-soon page. Opening the site requires a separate configuration flag or a code change that treats an unset password as ungated.

---

### R-08 — Upload complete does not verify the object is an MP4

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Medium (any signed-in user) |
| **Location** | `worker/src/index.ts` (`createUpload`, `completeUpload`) |

**Description.** Presigned PUTs bind `Content-Type: video/mp4`. Complete HEADs the object and requires `size === expected_size_bytes`. There is no magic-byte / `ftyp` check on the Worker (the desktop download path does this locally). Client `contentType` is ignored (good). Max size is 8 GB.

**Impact.** A signed-in user can store arbitrary bytes up to quota under an `.mp4` key. That is mainly quota abuse and a future XSS/content-sniffing concern if objects are ever served with a guessed type. Playback clients may fail closed.

**Remediation.** On complete, read the first ~32 bytes (R2 range GET or Worker binding) and require an ISO BMFF `ftyp` box, matching `src-tauri/src/upload.rs`. Reject and refund quota otherwise.

---

### R-09 — Desktop CSP and asset protocol are overly broad

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Low (needs XSS first); raises blast radius |
| **Location** | `src-tauri/tauri.conf.json` |

**Description.** Production CSP:

- `script-src` inherits `default-src 'self'` (good).
- `style-src 'self' 'unsafe-inline'`.
- `connect-src` includes `https:` (any origin).
- `img-src` / `media-src` allow `https:`.
- `assetProtocol.scope` is `$HOME/**`, `$VIDEO/**`, `$DOCUMENT/**`, `$APPDATA/**`.

Runtime code also expands the asset scope to clip save roots (`src-tauri/src/paths.rs` `allow_clip_asset_roots`).

**Impact.** A successful XSS in the desktop WebView can exfiltrate the session (R-10/R-17), read a large portion of the user’s home via `asset://`, and call every allowed IPC command.

**Remediation.** Narrow `connect-src` to Supabase, `https://www.replayr.tv`, `https://replayr.tv`, and required CDNs. Shrink `assetProtocol.scope` to Videos / the configured save folder. Prefer hashed or non-inline styles if the UI allows it.

---

### R-10 — Website persists the Supabase session in `localStorage`

| | |
| --- | --- |
| **Severity** | Medium (standard SPA tradeoff) |
| **Likelihood** | Tied to XSS |
| **Location** | `web/src/lib/supabase.ts` |

**Description.** The web client uses default `supabase-js` storage (localStorage). Desktop uses Tauri-backed storage. Mobile native uses `expo-secure-store`. Worker-served pages set a reasonably strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` in `worker/src/index.ts` `withWebSecurityHeaders`).

**Impact.** Any XSS on `www.replayr.tv` is account takeover (refresh token).

**Remediation.** Keep CSP tight. Avoid new HTML sinks. Longer term, consider cookie-based sessions with `HttpOnly` + `Secure` + `SameSite=Lax` if you introduce a first-party auth cookie (today the API is Bearer-only, which is good for CSRF).

---

### R-11 — Some clip route IDs are interpolated into PostgREST URLs without UUID validation

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Low (requires a crafted path; `user_id` is still applied on mutations) |
| **Location** | `worker/src/index.ts` (`complete`, `upload-parts`; contrast `deleteClip`) |

**Description.** `DELETE /v1/clips/:id` validates a UUID. `POST /v1/clips/:id/complete` and `upload-parts` take `([^/]+)` and interpolate it into `/clips?id=eq.${clipId}&user_id=eq.${user.id}`. PostgREST treats `,()` as filter syntax.

**Impact.** Filter injection against the caller’s own rows is the realistic case (the `user_id` clause remains). Still, unvalidated identifiers in query strings are a recurring source of IDOR when a later route forgets the owner filter.

**Remediation.** Reuse the same UUID regex as `deleteClip` on every `:clipId` / `:folderId` path before building a PostgREST URL. Prefer a shared `requireUuid()`.

---

### R-12 — Unauthenticated error and analytics ingest can be abused

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Medium |
| **Location** | `worker/src/errors.ts`, analytics handlers |

**Description.** `POST /v1/errors` is unauthenticated. Messages and stacks are length-limited and scrubbed for tokens (good). Rate limit is 20/min/IP in a local `Map`. Analytics event ingest is similarly optional-auth with an in-memory cap.

**Impact.** An attacker can pollute the admin error console and product metrics. Not a direct data breach.

**Remediation.** Durable rate limits (R-06). Optional signed ingest token for desktop/mobile builds. Cap distinct fingerprints per IP per day.

---

### R-13 — Announcement CTAs allow `http:` URLs

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Low (admin-only write path) |
| **Location** | `worker/src/announcements.ts` `sanitizeCtaUrl` |

**Description.** Relative site paths and `https:` are accepted. `http:` is also accepted. The web UI opens external CTAs with `noopener,noreferrer` (good).

**Impact.** A compromised or mistaken admin account can send users to an unencrypted or phishing URL.

**Remediation.** Allow only `https:` and same-origin relative paths (`/` but not `//`).

---

### R-14 — Export destination allowlist has a string-prefix fallback

| | |
| --- | --- |
| **Severity** | Medium |
| **Likelihood** | Low |
| **Location** | `src-tauri/src/paths.rs` `assert_export_dest_allowed` |

**Description.** Canonical `starts_with` checks are used first. If those fail, a lowercase string prefix compare allows destinations that merely begin with the root path text (sibling folders with a shared prefix).

**Impact.** Combined with R-03, export can write outside the intended Videos/Documents/Downloads roots in edge cases.

**Remediation.** Delete the string-prefix fallback. Only accept canonical ancestors, plus a controlled “create nested folder under an allowed root” path that still uses `Path` components, not string prefixes.

---

### R-15 — Worker JWT introspection cache (45s)

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `worker/src/shared.ts` (`AUTH_CACHE_TTL_MS = 45_000`) |

**Description.** `requireUser` caches successful `/auth/v1/user` results per token for 45 seconds in isolate memory.

**Impact.** A revoked session can still call the Worker for up to that window on that isolate.

**Remediation.** Skip the cache on account deletion, password change, and other destructive routes. Consider JWKS local verification plus a short denylist.

---

### R-16 — Overlay window granted `core:default`

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `src-tauri/capabilities/overlay.json` |

**Description.** The clip-saved overlay is display-only and does not register app commands (good). It still receives `core:default` (window/webview/path defaults).

**Remediation.** Grant only `core:event:allow-listen` and `core:event:allow-unlisten`.

---

### R-17 — Generic `auth_get_item` / `auth_set_item` IPC

| | |
| --- | --- |
| **Severity** | Low (High if grouped with WebView XSS) |
| **Location** | `src-tauri/src/commands.rs`, `src-tauri/src/auth.rs` `safe_key` |

**Description.** Any key matching `[A-Za-z0-9._-]{1,128}` can be read or written, including the session storage key. Path traversal in the key is blocked.

**Remediation.** Expose fixed commands (`get_session`, `set_session`, `clear_session`) for the known storage key only.

---

### R-18 — Unlisted clip titles written into client-side OG/title tags

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `web/src/pages/ClipPage.tsx`, `web/src/lib/seo.ts` |

**Description.** Unlisted playback is intentional. The page sets `noindex,nofollow` (good) but still sets `document.title` / `og:title` from the clip title after a JS fetch. `index.html` has no clip-specific OG tags, so non-JS crawlers see a generic page.

**Impact.** JS-capable preview bots may show an unlisted title in a chat unfurl.

**Remediation.** For `visibility !== 'public'`, use a generic title (“Replayr clip”) in `Seo`. Optionally SSR OG in the Worker only for public clips.

---

### R-19 — Fallback clip HTML missing CSP headers

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `worker/src/index.ts` (fallback player when `ASSETS` is absent) |

**Description.** The marketing SPA and coming-soon page set CSP, `X-Frame-Options: DENY`, and `nosniff`. The embedded fallback clip HTML sets `content-type` only. Production normally serves `web/dist` via Workers Assets.

**Remediation.** Add security headers to the fallback response, but do not pipe it through `withWebSecurityHeaders` unchanged. That helper sets `script-src 'self'`, and the fallback player’s loader is an inline `<script>` (`worker/src/index.ts`). In the no-`ASSETS` case this page is the only player, so a copy-paste CSP would block the fetch and leave “Loading clip…”. Externalize the script, or authorize it with a nonce or hash, then apply a fallback-specific CSP.

---

### R-20 — `opener:default` and unconstrained `save_location`

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `src-tauri/capabilities/default.json`, settings / `src-tauri/src/capture.rs` |

**Description.** `opener:default` allows the frontend to open `http(s)` URLs in the system browser (used for OAuth and billing). `save_location` is taken from settings without checking it is under the user profile; recordings and asset-protocol roots follow it.

**Remediation.** Scope opener to `https://*.supabase.co`, `https://*.replayr.tv`, and Stripe. Validate `save_location` via the directory picker result and reject system directories.

---

### R-21 — Thumbnail PUT has no post-upload content check

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `worker/src/index.ts` (thumb key presigned as `image/bmp`) |

**Description.** The thumb object can hold arbitrary bytes up to whatever the client uploads. It is not used as HTML in the Worker player (URLs are signed R2).

**Remediation.** Enforce a small max size and BMP/JPEG/WebP magic on a HEAD/range read.

---

### R-22 — Group chats: any member can add others

| | |
| --- | --- |
| **Severity** | Low (product policy) |
| **Location** | `worker/src/social.ts` (`addMembers`) |

**Description.** Membership is required; owner role is not. Mutual-follow is still required for the invitee (good). Blocks return 404 on profiles (good).

**Remediation.** If the product intent is “owner/admin invites only,” add a role check. Document the current behavior if it is intentional.

---

### R-23 — `/v1/health` discloses whether R2 is configured

| | |
| --- | --- |
| **Severity** | Low |
| **Location** | `worker/src/index.ts` |

**Description.** Returns `{ ok, storage: bool }` with no auth. Useful for ops; slightly helpful to attackers mapping the deployment.

**Remediation.** Keep `ok`; hide `storage` in production, or require a shared ops header.

---

### R-24 — Share slugs are random (~50 bits), not sequential

| | |
| --- | --- |
| **Severity** | Informational |
| **Location** | `worker/src/index.ts` `randomSlug` |

**Description.** 10 bytes from `crypto.getRandomValues`, mapped onto a 32-character alphabet (`256 % 32 == 0`, no modulo bias). Space is 32¹⁰ ≈ 1.1×10¹⁵. Lookup requires `^[a-z0-9]{6,16}$`. Public folder tokens are 16 random bytes, stored as SHA-256 hashes.

Unlisted access by slug is **by design**. Enumeration at the playback rate limit is not practical.

**Optional hardening.** Lengthen slugs to 12+ characters for defense in depth.

---

### R-25 — `wrangler.toml` defaults `PUBLIC_APP_URL` to localhost

| | |
| --- | --- |
| **Severity** | Informational |
| **Location** | `worker/wrangler.toml` `[vars]` |

**Description.** Production deploy passes `--var PUBLIC_APP_URL:https://replayr.tv --keep-vars` (`package.json` `web:deploy`). A deploy that omits the flag can mark analytics as `development`.

**Remediation.** Set the production var in the Cloudflare dashboard and keep the localhost default for local `[env.dev]` only.

---

### R-26 — No `SECURITY.md`

| | |
| --- | --- |
| **Severity** | Informational |
| **Location** | repository root |

**Description.** README lists hard security rules. There is no public reporting contact or rotation runbook.

**Remediation.** Add `SECURITY.md` with an email, expected response, and a note that client apps never receive the service role.

---

## Positive controls already in place

These should be preserved. New features should not weaken them.

1. **Client env split** — Desktop/web/mobile only document `VITE_*` / `EXPO_PUBLIC_*`. Service role, R2, Stripe, Bunny, and `SITE_ACCESS_PASSWORD` stay Worker-side (`.env.example`, `README.md`, `docs/ARCHITECTURE.md`).
2. **RLS hardening** — `supabase/migrations/20260828200000_harden_database_security.sql`: `clips_select` is owner **or** `public`+`ready`; `storage_key` / `thumbnail_key` not granted; privileged-column triggers; FORCE RLS; Supabase Storage grants revoked.
3. **Unlisted not in Explore** — `/v1/clips/public` and trending filler use `visibility=eq.public&status=eq.ready`. Architecture explicitly forbids a PostgREST policy of `visibility IN ('public','unlisted')`.
4. **Server-minted R2 keys** — `ownedObjectKey()` regex + `..` reject. Delete/sign paths go through it.
5. **Quota** — Size checked against plan; complete requires exact R2 HEAD size; abandoned uploads cleaned by cron.
6. **Folder RBAC** — `permissionsFromRole` + `requireFolderPermission` in `worker/src/folders.ts`; writes are service-role only; clients have SELECT. Public tokens hashed (SHA-256). Ownership transfer is a `SECURITY DEFINER` RPC granted only to `service_role`.
7. **Social / DMs** — Worker `requireMemberConversation`; RLS on `messages` / `conversations` uses membership `EXISTS`. Removed `is_conversation_member` SECURITY DEFINER helper. Private clips cannot be sent in DMs. Private profiles return a locked payload; blocked users 404.
8. **Admin** — `requireAdmin` checks `app_metadata.role === "admin"` and requires the service-role key. Client `RequireAdmin` is UI-only.
9. **CORS** — Explicit origin allowlist; no `*` with credentials (`worker/src/http.ts`).
10. **CSRF** — State-changing APIs require a Bearer JWT, not a cookie session. Site-access cookie is `HttpOnly; SameSite=Lax`.
11. **Webhooks** — Stripe HMAC + 300s timestamp window; Bunny HMAC on `/internal/webhooks/bunny`.
12. **Open redirects** — Billing `sanitizeReturnUrl` allows same origin, `replayr.tv`, or `replayr:` only.
13. **Tauri ACL** — No `tauri-plugin-fs` / `tauri-plugin-shell`. Commands listed in capability TOML. Overlay cannot invoke app commands. Updater uses HTTPS `latest.json` + embedded minisign public key. Deep link is `replayr:` + PKCE.
14. **Web XSS hygiene** — No `dangerouslySetInnerHTML` on user content. Comments, bios, DMs, and announcements render as text. Worker fallback player uses `textContent`.
15. **CI** — Only workflow is `.github/workflows/macos-dmg.yml`. No `pull_request` secret path. Secrets used are client-safe Vite values. `.tauri/` updater private key is gitignored.
16. **Analytics sanitization** — Property key blocklist (`password`, `token`, `service_role`, …); server-authoritative events rejected from client ingest.

---

## AuthN / AuthZ notes

### Authentication

| Client | How JWT is obtained | Where it is stored | How the Worker sees it |
| --- | --- | --- | --- |
| Desktop | Email/password + OAuth PKCE via system browser → `replayr://auth-callback` | Windows: DPAPI file. Others: plaintext file (R-04) | `Authorization: Bearer` |
| Web | PKCE; `/auth/callback`; desktop handoff at `/auth/desktop` | `localStorage` (R-10) | Bearer |
| Mobile | PKCE; SecureStore (chunked); web preview uses localStorage | SecureStore | Bearer |
| Worker | `GET {SUPABASE_URL}/auth/v1/user` | N/A (45s cache, R-15) | — |

`handle_new_user` (`supabase/migrations/20240821000000_init.sql`) creates `profiles` + `user_storage` and is executable only by `supabase_auth_admin`.

OAuth `redirectTo` values in-repo are first-party (`/auth/callback`, `https://www.replayr.tv/auth/desktop`). Confirm both stay on the Supabase Auth redirect allowlist (dashboard; not in git).

### Authorization model

| Action | Enforced where |
| --- | --- |
| List/select public clips | RLS + Worker `visibility=eq.public` |
| Play unlisted by slug | Worker `lookupPlayback` (anyone with slug) |
| Play private | Worker: owner JWT only |
| Mutate clips / quota / delete | Worker + `user_id` filter; client UPDATE limited to `title`, `visibility`, `description` |
| Folder roles | Worker `requireFolderPermission` |
| DMs | Worker membership + RLS |
| Admin | `app_metadata.role === "admin"` |

### Folder permission matrix (Worker)

| Permission | Owner | Manager | Editor | Viewer | Public link |
| --- | --- | --- | --- | --- | --- |
| view | ✓ | ✓ | ✓ | ✓ | ✓ (token) |
| download | ✓ | ✓ | ✓ | if `allowDownloads` | if `allow_public_downloads` |
| add/remove/edit clips | ✓ | ✓ | ✓ | — | — |
| manage folder / members / public share | ✓ | ✓ | — | — | — |
| delete folder / transfer ownership | ✓ | — | — | — | — |

UI gates (`src/pages/FolderPage.tsx`, editor pages) are not authoritative.

**Gap:** public-link playback does not re-apply clip visibility (R-01). Viewer `allowDownloads: false` still allows `/playback` streaming (likely intended).

---

## Upload / media pipeline

Intended flow (matches `docs/ARCHITECTURE.md` and the implementation):

1. `POST /v1/clips/uploads` + JWT → quota, insert `uploading` clip, mint key, return presigned PUT(s).
2. Client PUTs directly to R2 (`Content-Type: video/mp4`).
3. `POST /v1/clips/:id/complete` → HEAD size, mark `ready`, `add_storage_used`.
4. Cron aborts expired multipart leftovers.

| Control | Status |
| --- | --- |
| Client cannot choose object key | Pass |
| Path traversal on keys | Pass (`ownedObjectKey`) |
| Size limit 8 GB + exact size match | Pass |
| MIME trusted from client as final | Pass (ignored) |
| Magic-byte / MP4 validation | Fail (R-08) |
| Cross-user complete/delete | Pass (`user_id` filter) |
| SSRF via Worker `fetch` | No user-controlled fetch URL found |
| Presign TTL | 3600s upload/playback; 600–900s public folder |

Bunny watermark ingest uses a Worker-constructed URL and a hashed one-time token (`/internal/bunny-source/:token`), not a user-supplied URL.

---

## Desktop / Tauri specifics

| Topic | Assessment |
| --- | --- |
| IPC surface | ~58 commands, ACL-gated. Highest risk: upload `api_base`, share/export paths, download URL, generic auth keys |
| Shell | No shell plugin. Explorer/Finder reveal is gated for `reveal_local_clip` only |
| CSP | See R-09 |
| Updater | HTTPS endpoint + minisign pubkey in `tauri.conf.json`. Windows quiet install. **Protect** `.tauri/updater.key` and `latest.json` hosting |
| Overlay | Click-through, no app commands, capture exclusion. Still has `core:default` (R-16) |
| Deep links | `replayr:` scheme, PKCE code exchange. Billing deep link only refreshes billing state |
| Secrets in Rust | None found. Updater pubkey is public by design |

---

## Web / social surface

| Topic | Assessment |
| --- | --- |
| XSS | No user-content HTML sinks found in `web/` |
| CSRF | Bearer API; low risk. Waitlist / site-access are cookie-less POSTs (spam, not session CSRF) |
| Open redirects | Billing sanitized. Announcement `http:` CTAs (R-13) |
| IDOR clips / DMs / folders / profiles | Worker + RLS look sound except R-01 |
| Explore vs unlisted | Explore, game feeds, and trending keep `visibility=eq.public` |
| DM share of unlisted | Allowed by design; private blocked |
| Admin UI | Client-gated + server `requireAdmin` |
| `postMessage` / `window.opener` | No `postMessage`. External links use `noopener` |
| Coming-soon | API always reachable (intentional for desktop/mobile). SPA gate has R-07 |

---

## Privacy

| Rule | Status |
| --- | --- |
| Unlisted never in Explore / For You / public PostgREST lists | **Met** |
| Unlisted watchable with `/c/{slug}` | **By design** |
| Unlisted never in public listings | **Gap:** public folders (R-01) |
| Private = owner only | **Gap:** public folders (R-01) |
| Clip URLs do not include username | **Met** |
| Slug predictability | Random, ~50 bits (R-24) |
| Private profiles hide bio/clips | **Met** |
| Blocked users hidden | **Met** (404) |
| Unlisted OG title | Client-side leak to JS crawlers (R-18) |

---

## Secrets and config hygiene

| Item | Status |
| --- | --- |
| `.env.example` | Placeholders + comments. Warns against `VITE_` for server keys |
| `.env.production` | Only `VITE_PUBLIC_APP_URL=https://replayr.tv` (intentionally tracked) |
| `worker/wrangler.toml` | Secret **names** in comments; no values |
| `worker/.dev.vars` | Gitignored |
| `.tauri/` updater private key | Gitignored |
| Release `.exe` / `.dmg` / `.sig` | Gitignored |
| Committed `sk_live`, service role, `AKIA`, PEM, Discord webhooks | **None found** |
| Vite source maps | Not enabled (default). Site gate would serve `.map` if emitted |

**Assumption:** Production Wrangler secrets and the GitHub `Replayr` environment hold the real keys and are not in this repo.

---

## Dependency / supply-chain notes

Lockfiles exist for root, web, worker, mobile, and Rust (`Cargo.lock`).

`npm audit` (2026-09-13, this environment):

| Workspace | Result |
| --- | --- |
| Desktop (root), production deps | **0** vulnerabilities |
| Web, production deps | **0** vulnerabilities |
| Worker | **Dev-only:** `sharp` via `miniflare` / `wrangler` (libheif advisories). Not shipped in the Worker bundle |
| Mobile | Transitive advisories, including **high** `js-yaml` CPU issue (`GHSA-2883-xcg3-v3hh`) and moderate `decode-uri-component` / `uuid` issues, mostly via Expo tooling |

No `eval`, abandoned `request`, or `node-serialize`-style packages in first-party `package.json` files. Rust stack is Tauri 2, `reqwest` 0.12, `rusqlite` 0.32 (bundled), serde. SQL in Rust should stay parameterized (local library queries were not exhaustively reviewed line-by-line; prefer keeping rusqlite bind params).

**Remediation.** Bump `wrangler` when convenient to clear worker audit noise. Before a store release, refresh Expo and re-run `npm audit --prefix mobile`. Do not “audit fix --force” without a regression pass.

---

## CI

Single workflow: `.github/workflows/macos-dmg.yml`.

- Triggers: `workflow_dispatch`, tags `v*`, pushes to `main` (path-filtered). No `pull_request` trigger.
- Secrets: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only (client-safe).
- `permissions: contents: write` for GitHub Release upload of the DMG.
- Fails fast if Vite secrets are empty.

**Optional:** default `contents: read` and grant write only on the publish step. Add branch protection on `main`. There is no Windows NSIS CI in-repo (local `tauri:build`).

---

## Recommended priority fix order

### P0 — do these first

1. **R-01** — Enforce clip visibility on public folder list/playback/download. Never sign a private object for a public token.
2. **R-02** — Hard-code / allowlist Worker origin in Rust. Stop taking `api_base` from the UI.
3. **R-03** — Resolve share/export sources from a recorded `local_id` (not `assert_reveal_allowed`).

### P1 — before a wide public launch

4. **R-06** — Cloudflare (or DO/KV) rate limits on site-access, waitlist, errors, analytics, upload-create.
5. **R-07** — Narrow `isOAuthHandoff`. To open the site at launch, add an explicit ungated flag — unsetting `SITE_ACCESS_PASSWORD` keeps production locked.
6. **R-04** — Encrypt macOS/Linux session files.
7. **R-05**, **R-14**, **R-17** — Harden remaining desktop IPC (downloads, export dest, auth keys).
8. **R-08** — MP4 `ftyp` check on complete.
9. **R-11** — UUID-validate every interpolated PostgREST id.

### P2 — defense in depth

10. **R-09**, **R-16**, **R-20** — Tighten CSP, asset scope, overlay caps, opener hosts, `save_location`.
11. **R-10** — Keep web CSP strict; plan HttpOnly cookies only if you redesign auth.
12. **R-12**, **R-13**, **R-18**, **R-19** — Telemetry abuse, announcement HTTPS, unlisted OG, fallback CSP.
13. **R-21–R-26** — Thumbs, group-invite policy, health, slug length, wrangler vars, `SECURITY.md`.
14. Dependency bumps (mobile / wrangler).

---

## Suggested security checklist for launch

### Product / privacy

- [ ] Private clips cannot be listed or played via `/f/{token}` or `/v1/public/folders/*`.
- [ ] Unlisted clips still absent from `/v1/clips/public`, game feeds, profiles (unless owner), and Explore UI.
- [ ] Enabling a public folder link warns if the folder contains non-public clips.
- [ ] Unlisted player uses generic OG/title for crawlers.

### Auth

- [ ] Supabase redirect allowlist includes only first-party callbacks.
- [ ] Confirm email / leak-detection settings match the intended threat model.
- [ ] Admin role exists only in `app_metadata`, assigned via service role.
- [ ] Session lifetime and refresh rotation reviewed in the Auth dashboard.
- [ ] macOS session encryption shipped if Mac is a launch surface.

### Worker / R2

- [ ] Cloudflare Rate Limiting (or equivalent) on password, waitlist, upload, playback, telemetry.
- [ ] `PUBLIC_APP_URL` is `https://replayr.tv` (or `https://www.replayr.tv`) in production vars.
- [ ] R2 bucket is not world-listable; only presigned and Worker bindings.
- [ ] Stripe and Bunny webhook secrets set; test events verified.
- [ ] Coming-soon gate opened via an explicit ungated flag (not by deleting `SITE_ACCESS_PASSWORD`) **or** `?code=` bypass removed while the gate remains on.
- [ ] Upload complete verifies object size **and** MP4 identity.

### Desktop

- [ ] Rust allowlists API origin and download hosts.
- [ ] Share/export resolve the source from a recorded clip `local_id` (reveal’s root list is too wide for that).
- [ ] CSP `connect-src` no longer allows all `https:`.
- [ ] Updater private key is in a hardware-backed or tightly ACL’d store; `latest.json` is only writable by CI.
- [ ] Overlay capability is events-only.

### Web / mobile

- [ ] CSP headers present on all HTML responses, including the fallback player (nonce/hash or external script — not a blind `script-src 'self'`).
- [ ] No new `dangerouslySetInnerHTML` on user content.
- [ ] Mobile store builds use SecureStore (not web localStorage) and pinned deep-link hosts.
- [ ] `npm audit` clean enough for store review; lockfiles committed.

### Process

- [ ] `SECURITY.md` with a reporting address.
- [ ] Branch protection + required checks on `main`.
- [ ] Secret rotation runbook (Supabase service role, R2, Stripe, Bunny, site-access, updater key).
- [ ] New Worker routes reviewed for `requireUser` / ownership / membership before merge.

---

## Review limitations

This audit is a point-in-time static review of the repository. It does not prove the production database matches these migrations, that Cloudflare WAF is enabled, or that dashboard Auth settings match the README. Re-audit after large Worker or RLS changes; the service-role BFF pattern fails open on a single missed check.
