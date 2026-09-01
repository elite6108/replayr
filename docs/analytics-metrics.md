# Replayr metric dictionary

Canonical names and definitions. Do not invent aliases in dashboards later.

Timestamps are stored in UTC. The Admin week is **Monday–Sunday**. Query ranges are half-open **`[from, to)`**. Product analytics and the audit log are separate systems.

## Environment

- Worker events: `resolveAnalyticsEnvironment` from `PUBLIC_APP_URL` (`localhost` / `127.0.0.1` → `development`, otherwise `production`). Clients may send an explicit `production` | `development`. Never infer environment from user-controlled Auth metadata.
- Signup trigger: `public.analytics_environment()` = `replayr.analytics_environment` GUC, else `app_settings.analytics_environment`, else `production`.
- This production database holds production business records (`auth.users`, `clips`, billing, storage). DB-derived rollups write those counts onto `environment = public.analytics_environment()` (production here). Do not add an environment column to domain tables.
- Development analytics events stay on `environment = development` rows and are excluded from production event rollups.

Local Supabase (never run this on production):

```sql
update public.app_settings set analytics_environment = 'development' where id = 1;
-- or: alter database postgres set replayr.analytics_environment = 'development';
```

## Live server events (Phase A)

| Event | Source | Idempotency | Definition |
| --- | --- | --- | --- |
| `auth.signup_completed` | `auth.users` insert trigger | `auth.signup_completed:{userId}` | A Replayr account was created. |
| `clip.upload_completed` | Worker after a clip becomes `ready` | `clip.upload_completed:{clipId}` | A cloud clip finished upload and is ready. |
| `clip.upload_failed` | Worker after a clip is marked `failed` | `clip.upload_failed:{clipId}` | A cloud upload failed (size/key/expiry). |
| `folder.created` | Worker after folder insert | `folder.created:{folderId}` | A folder row was created. |

A retryable multipart finish **502** is not `clip.upload_failed`. The clip stays `uploading`.

`product_events` is still written for existing counters.

## Daily aggregates (Phase B)

Durable UTC-day tables. Future Admin pages query these, not raw `analytics_events`.

| Table | Grain |
| --- | --- |
| `analytics_daily` | users / signups / cloud-activated |
| `analytics_downloads_daily` | app vs media downloads (separate columns) |
| `analytics_clips_daily` | cloud uploads, ready clips, public views |
| `analytics_storage_daily` | original cloud MP4 quota only |
| `analytics_subscription_daily` | paid snapshot + estimated MRR |

Primary key on each: `(day, environment)`.

Cron: existing Worker `15 * * * *`. Each run upserts **today + previous 2 UTC days** via `rollup_analytics_days` then `rollup_analytics_growth_days`. Idempotent. Manual backfill: `POST /v1/admin/analytics/backfill` with `{ from, to }` as `[from, to)`, admin JWT required, max 366 days.

## Active users (Phase D)

A user is **active** on a UTC day when they perform at least one qualifying **authenticated** production event:

`app.opened`, `clip.saved`, `clip.upload_completed`, `clip.played`, `clip.editor_opened`, `clip.rendered`, `folder.created`, `folder.clip_added`.

Do not count: `last_sign_in_at`, marketing clicks, `auth.signup_*`, `capture.started`, `replay.enabled`, anonymous visitors, or cron.

**Activation** = first of `clip.saved` or `clip.upload_completed`. Source `local_clip` or `cloud_clip`. Historical users with only a ready cloud clip are `cloud_proxy`.

**Retention** = exact calendar day N after signup (or activation). Immature periods are null, never 0%. Week is Monday–Sunday.

**WAU KPI** = unique users in the selected 7-day period when the range is a week. **Chart** = rolling 7-day unique users. Same idea for MAU / 30 days.

Acquisition is first-party `anonymous_id` + first-touch UTM. Direct ≠ Unknown. Desktop install → account is not bridged yet.

## Product intelligence (Phase E)

Hourly rollup also upserts `rollup_analytics_product_days` for the same today + previous 2 UTC days.

| Table | Grain |
| --- | --- |
| `analytics_game_daily` | UTC day + `games.slug` (`unknown` if `clips.game_id` is null) |
| `analytics_user_game_first` | First ready cloud clip's game per user |
| `analytics_feature_daily` | UTC day + feature key |
| `analytics_filter_daily` | UTC day + `filter_id` |
| `analytics_folder_daily` | UTC day |
| `analytics_sharing_daily` | UTC day |

**Games** use normalized `games.slug`, never raw exe names. Unknown is a missing `game_id`, not Direct.

**Game community D7** = exact calendar day 7 after that user's first ready cloud clip of the game. Immature = null.

**Filters:** `visual.filter_selected` / `applied` / `rendered`. `none` is stored and excluded from “used”. Rendered also counts `clip.saved` / `clip.rendered` with `filter_id`.

**Features:** unique users with that event / DAU. `capture` and `replay` are adoption-only (not DAU). Repeat = users with ≥2 events that UTC day.

**Folders:** creates, clip adds, invites, public-link enables from folder tables. A folder user is an owner or `folder_members` row. Collaborators are members only.

**Sharing:** `clip.shared` after a successful DM send or copy-link. Public views and public downloads are available. Share → installer download is **not** identity-stitched (`NOT_INSTRUMENTED`).

**Power users:** top decile of ready cloud clips in the selected range. Paid share is a product correlation, not a revenue metric.

## Revenue and infrastructure (Phase F)

Hourly rollup also upserts `rollup_analytics_revenue_days` for today + previous 2 UTC days.

**Paid subscriber** = `billing_subscriptions.status` in `active` or `trialing`. Grants and `past_due` are excluded.

**Complimentary premium** = active `billing_grants` (not revoked, not expired).

**Premium user** = paid or complimentary. Never unlabeled as one KPI.

**Scheduled to cancel** = paid and `cancel_at_period_end`. Still paid until access ends.

**Churn** = (cancelled + expired in range) / paid subscribers at period start. `cancel_at_period_end` is not churn.

**Reactivation** = previously churned or past_due, then paid again.

Server events (Stripe/webhook only; clients cannot write `subscription.*`):

| Event | When |
| --- | --- |
| `subscription.checkout_started` | Worker after Stripe Checkout session URL is created |
| `subscription.started` | First paid (`active`/`trialing`) row |
| `subscription.renewed` | `invoice.paid` while already paid |
| `subscription.cancelled` | Left paid for `canceled` |
| `subscription.expired` | Left paid for `unpaid` / `incomplete_expired` |
| `subscription.reactivated` | Paid again after churn/past_due |

`pricing.viewed` is a client web event on the pricing page.

**Estimated MRR** uses Stripe `amount_cents` + interval when present, else $4.99 monthly / $3.99 yearly. Always labeled Estimated. Not Revenue. **Estimated ARR** = Estimated MRR × 12.

Free → paid is cohort-based (signup/activation → paid within 7/30 days). Immature windows are null.

Product → paid numbers are observed conversion among users of a feature/game. Minimum sample 10. Not causation. Dollars are not allocated to games.

Storage scope remains original cloud MP4 quota. Deleted bytes stay INCOMPLETE. Net growth is null.

`analytics_cost_assumptions` holds provider rates. Seed is R2 storage $0.015/GB-month. Bandwidth rates exist as placeholders; usage is `NOT_INSTRUMENTED` and is not shown as 0.

Forecast = recent average daily **storage added** × 30/90. Gross-growth because deletes are incomplete. Projected cost uses the effective R2 storage assumption.

Admin: `/admin/analytics/revenue`, `/admin/analytics/infrastructure`. APIs: `GET /v1/admin/analytics/revenue`, `GET /v1/admin/analytics/infrastructure`, `PATCH /v1/admin/analytics/cost-assumptions`.

## Product health (Phase G)

Hourly rollup also upserts `rollup_analytics_health_days`.

| Rate | Denominator |
| --- | --- |
| Clip save success | `clip.saved / (clip.saved + clip.save_failed)` excluding `failure_category=cancelled` |
| Upload success | terminal `clip.upload_completed / (completed + failed)`. Retryable 502 is never a failure. |
| Render success | `clip.rendered / (rendered + clip.render_failed)`. User cancel is not emitted. |

Playback and download failure rates are **NOT_INSTRUMENTED**.

`error_events` remains the technical error log. Product Health links to `/admin/errors` and does not return stacks.

Regression: both versions need ≥100 relevant operations; failure rate up ≥25% relative **and** ≥1pp absolute.

New client event: `clip.render_failed` (`render_type`, `error_category`). No paths or encoder dumps.

## Audit log (Phase H)

`public.audit_log` is append-only operations/security history. It is **not** `analytics_events`, `folder_activity`, or `error_events`.

- Client roles have no SELECT/INSERT/UPDATE/DELETE.
- `service_role` may INSERT and SELECT only.
- Retention is independent of analytics events. V1: retain indefinitely. No delete cron.
- Actor is always derived server-side.
- Public folder tokens never go in metadata.

Admin: `/admin/audit`. API: `GET /v1/admin/audit` (paginated).

## Metric availability

`analytics_metric_catalog` and `worker/src/analyticsAvailability.ts`.

| Status | Meaning |
| --- | --- |
| `AVAILABLE` | Trustworthy for Admin |
| `PROXY` | Real but narrower than the eventual name |
| `INCOMPLETE` | Partial / nullable |
| `NOT_INSTRUMENTED` | Must not display as zero |
| `AVAILABLE_ESTIMATE` | Number exists; not revenue |

| Metric | Availability |
| --- | --- |
| New users | AVAILABLE (`auth.users.created_at`, present accounts only) |
| Signups | AVAILABLE (events for that environment) |
| DAU / `active_users` | INCOMPLETE from 2026-08-31. Unique authenticated users with a qualifying event that UTC day. Not `last_sign_in_at`. |
| WAU | INCOMPLETE until 2026-09-06. Unique users in 7 days, not the sum of DAUs. |
| MAU | INCOMPLETE until 2026-09-29. Unique users in 30 days, not the sum of DAUs. |
| True activated | First `clip.saved` or `clip.upload_completed`. Historical cloud-only is `cloud_proxy`. |
| Cloud-activated | PROXY (first ready cloud clip, once per user) |
| App download clicks | AVAILABLE from 2026-08-31 |
| Installer downloads | AVAILABLE from 2026-08-31 |
| Clip / folder downloads | AVAILABLE from 2026-08-31 |
| Cloud upload completed / failed | AVAILABLE |
| Upload success rate | AVAILABLE — `completed / (completed + failed)` |
| Ready cloud clips / bytes | AVAILABLE (original MP4 `file_size_bytes`) |
| Public clip views | AVAILABLE (`clip_daily_views`) |
| Local clips saved | AVAILABLE from 2026-08-31 (`clip.saved` after a successful desktop save) |
| Storage EOD total (today) | AVAILABLE — `sum(user_storage.storage_used_bytes)`, original MP4 quota only |
| Storage added | AVAILABLE — ready clip bytes that day |
| Storage deleted / net | INCOMPLETE — net is stored null |
| Active paid EOD (today) | AVAILABLE |
| New / cancelled from Stripe events | INCOMPLETE |
| Estimated MRR | AVAILABLE_ESTIMATE — `mrr_is_estimate = true`. Do not label Revenue. |

Storage scope: **original cloud media only**. Not thumbnails, Bunny derivatives, or other provider storage.

Upload success denominator: terminal clip outcomes only. Failed clips already include expired (`failClip` then session delete) and size-mismatch abort. Leftover `upload_sessions` aborted/expired rows are **not** added again. Retryable 502 is excluded.

Cloud-activated day is the first currently-ready clip’s `created_at` (upload row creation). There is no `ready_at` column.

## Download instrumentation still needed

Do not treat a button click as an installer download.

| Event | Hook | Auth | Success | Idempotency |
| --- | --- | --- | --- | --- |
| `app.download_clicked` | Marketing buttons (`web` HomePage `/releases/Replayr.exe` and `.dmg` links) | Anonymous | Click / navigation start | Client event id; not a completed download |
| `app.installer_downloaded` | Worker before `ASSETS.fetch` on `GET /releases/Replayr.exe` and `.dmg` | Anonymous | **200** file response. Not `latest.json`. Not a click. | Optional daily+IP hash; prefer counting successful responses |
| `clip.downloaded` | `GET /v1/clips/:slug/download` after a real file starts (`streamR2Original` 200 or branded redirect). Not `202 preparing`. | Signed-in | Response that starts the file. Redirect/stream ≠ client finished saving. | `clip.downloaded:{clipId}:{userId}:{utcDay}` if unique-downloader is needed |
| `clip.public_downloaded` | Same route, anonymous / public viewer | Anonymous | Same as above | `clip.public_downloaded:{clipId}:{utcDay}:{coarseId}` |
| `folder.public_downloaded` | `GET /v1/public/folders/:token/clips/:clipId/download` after a signed URL is issued | Anonymous | JSON `{ downloadUrl }` issued (request for URL, not byte completion) | `folder.public_downloaded:{folderId}:{clipId}:{utcDay}:{coarseId}` |

Authenticated vs public clip downloads stay separate. App downloads never merge into media totals.

## Query helpers (Phase C)

Worker internals only — no dashboard HTTP API yet:

- `getOverviewDailySeries` / `getDownloadDailySeries` / `getClipDailySeries` / `getStorageDailySeries` / `getSubscriptionDailySeries`
- Dates: `worker/src/analyticsDates.ts` (`[from, to)`, Monday week, UTC month)

Default environment for Admin queries: `production`.

## Client ingest

`POST /v1/analytics/events` accepts product/UI events (`app.opened`, `clip.saved`, …).

Clients cannot write:

- `subscription.*`, `billing.*`, `revenue.*`, `payment.*`
- Phase A server-authoritative names listed above

## Privacy

Do not put tokens, passwords, auth headers, message bodies, clip bytes, or raw IPs in `properties`. Country is coarse (`CF-IPCountry`) only.

## Reports (Phase I)

Immutable Admin snapshots. Not scheduled email. Metrics come from the existing builders — reports do not redefine them.

| Item | Detail |
| --- | --- |
| Table | `public.analytics_reports` (service_role SELECT+INSERT only; no UPDATE/DELETE) |
| Types | daily, weekly, monthly, quarterly, ytd, custom. Week is Monday–Sunday. UI inclusive; stored `[from, to)`. Default TZ `America/New_York`. |
| Version | `report_version = 1`, `metric_dictionary_version = 1` |
| Generate | `POST /v1/admin/analytics/reports` — Worker calls existing `buildAnalytics*` services in parallel |
| Read | `GET /v1/admin/analytics/reports`, `GET /v1/admin/analytics/reports/:id` — saved JSON only |
| Regenerate | `POST /v1/admin/analytics/reports/:id/regenerate` — new row + `regenerated_from_id`. Original unchanged. |
| PDF | `GET` or `POST /v1/admin/analytics/reports/:id/pdf` — on-demand PDF 1.4 from snapshot JSON. `pdf_object_key` stays null. Failure does not mutate the snapshot. |
| CSV | `GET /v1/admin/analytics/reports/:id/export/:topic` — UTF-8, ISO dates, raw numbers. Empty topic = header + `No tracked data for this period`. |
| Audit | `analytics.report_generated`, `analytics.report_regenerated`. Metadata is report_id / type / period only. |
| Admin | `/admin/analytics/reports`, `/admin/analytics/reports/:id` |

Delete is skipped in V1. Scheduled / email reports are Phase J.
