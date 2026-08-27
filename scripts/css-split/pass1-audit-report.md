# Pass 1 CSS split audit

## Module file list (barrel order)

1. `src/styles/tokens.css` (rules 0–0)
2. `src/styles/globals.css` (rules 1–9)
3. `src/styles/shell.css` (rules 10–11)
4. `src/styles/nav.css` (rules 12–25)
5. `src/styles/topbar.css` (rules 26–42)
6. `src/styles/ui-page.css` (rules 43–47)
7. `src/styles/settings.css` (rules 48–69)
8. `src/styles/ui-chrome.css` (rules 70–77)
9. `src/styles/games.css` (rules 78–89)
10. `src/styles/ui-shared.css` (rules 90–138)
11. `src/styles/record.css` (rules 139–142)
12. `src/styles/clips.css` (rules 143–172)
13. `src/styles/auth.css` (rules 173–177)
14. `src/styles/clips-detail.css` (rules 178–192)
15. `src/styles/toast.css` (rules 193–196)
16. `src/styles/record-audio.css` (rules 197–205)
17. `src/styles/auth-onboarding.css` (rules 206–227)
18. `src/styles/player.css` (rules 228–245)
19. `src/styles/home.css` (rules 246–257)
20. `src/styles/admin.css` (rules 258–265)
21. `src/styles/explore-feed.css` (rules 266–277)
22. `src/styles/editor.css` (rules 278–326)
23. `src/styles/social-messages.css` (rules 327–384)
24. `src/styles/header-popovers.css` (rules 385–395)
25. `src/styles/home-search.css` (rules 396–401)
26. `src/styles/announce.css` (rules 402–415)
27. `src/styles/sources-webcam.css` (rules 416–444)

Barrel: `src/styles/app.css` (@import only). Entry unchanged: `src/main.tsx` → `./styles/app.css`.

## Rule counts

| Metric | Before (monolith) | After (disk concat) |
|---|---:|---:|
| Total top-level rules | 445 | 445 |
| Normal style rules | 440 | 440 |
| @media blocks | 4 | 4 |
| @keyframes | 1 | 1 |
| Declarations (approx `;` count) | 1852 | 1852 |

## Selector set equality

- Missing after split: none
- Extra after split: none
- Result: **PASS**

## Ordered normalized rule-sequence equality

- Memory reconstruct first mismatch index: none (PASS)
- Disk concat first mismatch index: none (PASS)
- Result: **PASS**

## Per-module sizes

| File | Rules | Style | Media | Keyframes | Decls |
|---|---:|---:|---:|---:|---:|
| tokens.css | 1 | 1 | 0 | 0 | 25 |
| globals.css | 9 | 9 | 0 | 0 | 23 |
| shell.css | 2 | 2 | 0 | 0 | 11 |
| nav.css | 14 | 14 | 0 | 0 | 84 |
| topbar.css | 17 | 17 | 0 | 0 | 89 |
| ui-page.css | 5 | 5 | 0 | 0 | 24 |
| settings.css | 22 | 21 | 1 | 0 | 76 |
| ui-chrome.css | 8 | 8 | 0 | 0 | 29 |
| games.css | 12 | 12 | 0 | 0 | 57 |
| ui-shared.css | 49 | 49 | 0 | 0 | 178 |
| record.css | 4 | 3 | 0 | 1 | 16 |
| clips.css | 30 | 30 | 0 | 0 | 164 |
| auth.css | 5 | 5 | 0 | 0 | 15 |
| clips-detail.css | 15 | 15 | 0 | 0 | 50 |
| toast.css | 4 | 4 | 0 | 0 | 20 |
| record-audio.css | 9 | 9 | 0 | 0 | 39 |
| auth-onboarding.css | 22 | 22 | 0 | 0 | 70 |
| player.css | 18 | 18 | 0 | 0 | 100 |
| home.css | 12 | 11 | 1 | 0 | 50 |
| admin.css | 8 | 8 | 0 | 0 | 27 |
| explore-feed.css | 12 | 12 | 0 | 0 | 49 |
| editor.css | 49 | 49 | 0 | 0 | 183 |
| social-messages.css | 58 | 57 | 1 | 0 | 222 |
| header-popovers.css | 11 | 11 | 0 | 0 | 60 |
| home-search.css | 6 | 6 | 0 | 0 | 34 |
| announce.css | 14 | 14 | 0 | 0 | 53 |
| sources-webcam.css | 29 | 28 | 1 | 0 | 104 |

## Ambiguous classifications (kept contiguous for cascade)

- `.avatar` base lives in `ui-page.css` (immediately after topbar); size variants in `auth-onboarding.css`.
- `.topbar-user.sign-in` lives in `ui-chrome.css` (after tabs), not `topbar.css`.
- `.setting-row` / `.hotkey-recorder*` / topbar-chip hotkey overrides live in `ui-shared.css` (between field and switch), not settings/topbar.
- Auth island (`.auth-modes` … `.auth-social`) is its own `auth.css` between `clips.css` and `clips-detail.css`.
- `.clip-card-actions` is in `games.css` (between game-hero and grid).
- `kbd` / `code` element rules sit in `auth-onboarding.css` (historical placement).
- `.page:has(.social-fill)` is in `social-messages.css`.
- Discover/explore-rail blocks sit inside `social-messages.css` (between picker and send sheet).
- `.home-greeting` / search styles are in `home-search.css` (after header popovers), separate from `home.css`.

## Cascade-sensitive / special handling

- `@media (max-width: 1100px)` after home (rule 257) kept **atomic** in `home.css`; it contains both `.home-layout` and `.topbar-actions { display: none }`. Not split into two @media blocks (would change top-level ordered sequence / media count).
- `@keyframes pulse-live` kept immediately after `.record-orb.live` in `record.css`.
- Settings `@media (max-width: 860px)` kept atomic in `settings.css`.
- Social `@media (max-width: 980px)` kept atomic in `social-messages.css`.
- Webcam `@media (max-width: 1100px)` kept atomic in `sources-webcam.css`.

## Suspected dead selectors (not deleted; not left as CSS comments)

Documented for a later cleanup PR only:

- `.catalog-list` / `li`
- `.coming-soon` (paired with `.hero-status`)
- `.clip-actions`, `.clip-cloud-link`, `.clip-cloud-mark`, `.clip-title`
- `.game-chip` / `.game-chip-row`
- `.stat-card .stat-value`, `.status-dot`, `.topbar-spacer`, `.ok-text`
- bare `.empty` (vs `.empty-state`)

## Build result

- `npm run build` (`tsc --noEmit && vite build`): **PASS**
- Emitted `dist/assets/main-*.css` (~42.8 kB) includes cascade-sensitive samples: `place-bottom-left` / `bottom:11%`, `@keyframes pulse-live`, home `@media` hiding `.topbar-actions`, webcam `@media` for `.webcam-layout`, `:root` tokens.

## Visual smoke results

| Check | Result |
|---|---|
| Selector set vs monolith | PASS (no missing/extra) |
| Ordered rule-sequence vs monolith | PASS (445/445) |
| Declaration count | 1852 → 1852 |
| @media / @keyframes counts | 4 / 1 unchanged; internal rule order preserved (atomic blocks) |
| Production CSS spot-check (editor bottom margin, pulse, media halves) | PASS |
| Interactive desktop page walkthrough | Not fully exercised here — Vite client is up (`localhost:1420`); Tauri cargo was still compiling after prior LNK clean. Mechanical identity implies no intentional visual change; confirm shell/nav/topbar, record/webcam, library clips, editor/player overlay, social, settings in the running app. |

## Out of scope (unchanged)

- `src/styles/overlay.css`
- `web/src/styles.css`
- No class renames, no declaration edits, no dead-CSS deletion.

## Artifacts

- Monolith snapshot: `src/styles/app.css.monolith.bak`
- Split + verify: `scripts/css-split/split-pass1.mjs`, `scripts/css-split/parse-css-rules.mjs`
- This report: `scripts/css-split/pass1-audit-report.md`
