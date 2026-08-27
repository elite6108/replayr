/**
 * Pass-1 modular CSS split from app.css monolith.
 * Contiguous rule ranges preserve ordered rule-sequence when barrel-imported.
 */
import fs from "fs";
import path from "path";
import {
  parseTopLevelRules,
  normalizeRuleText,
  countDeclarations,
  selectorKey,
} from "./parse-css-rules.mjs";

const ROOT = path.resolve("src/styles");
const MONOLITH = path.join(ROOT, "app.css.monolith.bak");
const REPORT = path.join("scripts/css-split", "pass1-audit-report.md");

/** Contiguous [start, end] inclusive rule indices → module file (barrel order). */
const SEGMENTS = [
  { file: "tokens.css", start: 0, end: 0 },
  { file: "globals.css", start: 1, end: 9 },
  { file: "shell.css", start: 10, end: 11 },
  { file: "nav.css", start: 12, end: 25 },
  { file: "topbar.css", start: 26, end: 42 },
  { file: "ui-page.css", start: 43, end: 47 },
  { file: "settings.css", start: 48, end: 69 },
  { file: "ui-chrome.css", start: 70, end: 77 },
  { file: "games.css", start: 78, end: 89 },
  { file: "ui-shared.css", start: 90, end: 138 },
  { file: "record.css", start: 139, end: 142 },
  { file: "clips.css", start: 143, end: 172 },
  { file: "auth.css", start: 173, end: 177 },
  { file: "clips-detail.css", start: 178, end: 192 },
  { file: "toast.css", start: 193, end: 196 },
  { file: "record-audio.css", start: 197, end: 205 },
  { file: "auth-onboarding.css", start: 206, end: 227 },
  { file: "player.css", start: 228, end: 245 },
  { file: "home.css", start: 246, end: 257 },
  { file: "admin.css", start: 258, end: 265 },
  { file: "explore-feed.css", start: 266, end: 277 },
  { file: "editor.css", start: 278, end: 326 },
  { file: "social-messages.css", start: 327, end: 384 },
  { file: "header-popovers.css", start: 385, end: 395 },
  { file: "home-search.css", start: 396, end: 401 },
  { file: "announce.css", start: 402, end: 415 },
  { file: "sources-webcam.css", start: 416, end: 444 },
];

function joinRules(rules) {
  return rules.map((r) => normalizeRuleText(r.text)).join("\n\n") + "\n";
}

function stats(rules) {
  return {
    totalRules: rules.length,
    style: rules.filter((r) => r.kind === "style").length,
    media: rules.filter((r) => r.kind === "media").length,
    keyframes: rules.filter((r) => r.kind === "keyframes").length,
    at: rules.filter((r) => r.kind === "at").length,
    declarations: rules.reduce((n, r) => n + countDeclarations(r.text), 0),
    selectors: rules
      .filter((r) => r.kind === "style")
      .map((r) => selectorKey(r.prelude)),
  };
}

function main() {
  const css = fs.readFileSync(MONOLITH, "utf8");
  const rules = parseTopLevelRules(css);

  // Validate contiguous cover
  let expected = 0;
  for (const seg of SEGMENTS) {
    if (seg.start !== expected) {
      throw new Error(
        `Gap/overlap before ${seg.file}: expected start ${expected}, got ${seg.start}`,
      );
    }
    if (seg.end < seg.start || seg.end >= rules.length) {
      throw new Error(`Bad range for ${seg.file}: ${seg.start}-${seg.end}`);
    }
    expected = seg.end + 1;
  }
  if (expected !== rules.length) {
    throw new Error(
      `Incomplete cover: covered ${expected}, total ${rules.length}`,
    );
  }

  const before = stats(rules);
  const written = [];
  const reconstructed = [];

  for (const seg of SEGMENTS) {
    const slice = rules.slice(seg.start, seg.end + 1);
    const body = joinRules(slice);
    const outPath = path.join(ROOT, seg.file);
    fs.writeFileSync(outPath, body, "utf8");
    written.push({ file: seg.file, ...stats(slice), start: seg.start, end: seg.end });
    reconstructed.push(...slice);
  }

  const barrel = SEGMENTS.map((s) => `@import "./${s.file}";`).join("\n") + "\n";
  fs.writeFileSync(path.join(ROOT, "app.css"), barrel, "utf8");

  const after = stats(reconstructed);

  // Selector set equality
  const setBefore = new Set(before.selectors);
  const setAfter = new Set(after.selectors);
  const missing = [...setBefore].filter((s) => !setAfter.has(s));
  const extra = [...setAfter].filter((s) => !setBefore.has(s));

  // Ordered normalized rule-sequence equality
  const seqBefore = rules.map((r) => normalizeRuleText(r.text));
  const seqAfter = reconstructed.map((r) => normalizeRuleText(r.text));
  let firstMismatch = -1;
  const max = Math.max(seqBefore.length, seqAfter.length);
  for (let i = 0; i < max; i++) {
    if (seqBefore[i] !== seqAfter[i]) {
      firstMismatch = i;
      break;
    }
  }

  // Re-read written files in barrel order and compare again (disk truth)
  const diskRules = [];
  for (const seg of SEGMENTS) {
    const text = fs.readFileSync(path.join(ROOT, seg.file), "utf8");
    diskRules.push(...parseTopLevelRules(text));
  }
  const diskSeq = diskRules.map((r) => normalizeRuleText(r.text));
  let diskMismatch = -1;
  for (let i = 0; i < Math.max(seqBefore.length, diskSeq.length); i++) {
    if (seqBefore[i] !== diskSeq[i]) {
      diskMismatch = i;
      break;
    }
  }
  const diskStats = stats(diskRules);
  const diskSet = new Set(
    diskRules.filter((r) => r.kind === "style").map((r) => selectorKey(r.prelude)),
  );
  const diskMissing = [...setBefore].filter((s) => !diskSet.has(s));
  const diskExtra = [...diskSet].filter((s) => !setBefore.has(s));

  const report = `# Pass 1 CSS split audit

## Module file list (barrel order)

${SEGMENTS.map((s, i) => `${i + 1}. \`src/styles/${s.file}\` (rules ${s.start}–${s.end})`).join("\n")}

Barrel: \`src/styles/app.css\` (@import only). Entry unchanged: \`src/main.tsx\` → \`./styles/app.css\`.

## Rule counts

| Metric | Before (monolith) | After (disk concat) |
|---|---:|---:|
| Total top-level rules | ${before.totalRules} | ${diskStats.totalRules} |
| Normal style rules | ${before.style} | ${diskStats.style} |
| @media blocks | ${before.media} | ${diskStats.media} |
| @keyframes | ${before.keyframes} | ${diskStats.keyframes} |
| Declarations (approx \`;\` count) | ${before.declarations} | ${diskStats.declarations} |

## Selector set equality

- Missing after split: ${diskMissing.length === 0 ? "none" : diskMissing.join(" | ")}
- Extra after split: ${diskExtra.length === 0 ? "none" : diskExtra.join(" | ")}
- Result: **${diskMissing.length === 0 && diskExtra.length === 0 ? "PASS" : "FAIL"}**

## Ordered normalized rule-sequence equality

- Memory reconstruct first mismatch index: ${firstMismatch === -1 ? "none (PASS)" : firstMismatch}
- Disk concat first mismatch index: ${diskMismatch === -1 ? "none (PASS)" : diskMismatch}
- Result: **${diskMismatch === -1 && seqBefore.length === diskSeq.length ? "PASS" : "FAIL"}**

## Per-module sizes

| File | Rules | Style | Media | Keyframes | Decls |
|---|---:|---:|---:|---:|---:|
${written.map((w) => `| ${w.file} | ${w.totalRules} | ${w.style} | ${w.media} | ${w.keyframes} | ${w.declarations} |`).join("\n")}

## Ambiguous classifications (kept contiguous for cascade)

- \`.avatar\` base lives in \`ui-page.css\` (immediately after topbar); size variants in \`auth-onboarding.css\`.
- \`.topbar-user.sign-in\` lives in \`ui-chrome.css\` (after tabs), not \`topbar.css\`.
- \`.setting-row\` / \`.hotkey-recorder*\` / topbar-chip hotkey overrides live in \`ui-shared.css\` (between field and switch), not settings/topbar.
- Auth island (\`.auth-modes\` … \`.auth-social\`) is its own \`auth.css\` between \`clips.css\` and \`clips-detail.css\`.
- \`.clip-card-actions\` is in \`games.css\` (between game-hero and grid).
- \`kbd\` / \`code\` element rules sit in \`auth-onboarding.css\` (historical placement).
- \`.page:has(.social-fill)\` is in \`social-messages.css\`.
- Discover/explore-rail blocks sit inside \`social-messages.css\` (between picker and send sheet).
- \`.home-greeting\` / search styles are in \`home-search.css\` (after header popovers), separate from \`home.css\`.

## Cascade-sensitive / special handling

- \`@media (max-width: 1100px)\` after home (rule 257) kept **atomic** in \`home.css\`; it contains both \`.home-layout\` and \`.topbar-actions { display: none }\`. Not split into two @media blocks (would change top-level ordered sequence / media count).
- \`@keyframes pulse-live\` kept immediately after \`.record-orb.live\` in \`record.css\`.
- Settings \`@media (max-width: 860px)\` kept atomic in \`settings.css\`.
- Social \`@media (max-width: 980px)\` kept atomic in \`social-messages.css\`.
- Webcam \`@media (max-width: 1100px)\` kept atomic in \`sources-webcam.css\`.

## Suspected dead selectors (not deleted; not left as CSS comments)

Documented for a later cleanup PR only:

- \`.catalog-list\` / \`li\`
- \`.coming-soon\` (paired with \`.hero-status\`)
- \`.clip-actions\`, \`.clip-cloud-link\`, \`.clip-cloud-mark\`, \`.clip-title\`
- \`.game-chip\` / \`.game-chip-row\`
- \`.stat-card .stat-value\`, \`.status-dot\`, \`.topbar-spacer\`, \`.ok-text\`
- bare \`.empty\` (vs \`.empty-state\`)

## Out of scope (unchanged)

- \`src/styles/overlay.css\`
- \`web/src/styles.css\`
- No class renames, no declaration edits, no dead-CSS deletion.
`;

  fs.writeFileSync(REPORT, report, "utf8");

  console.log(JSON.stringify({
    before,
    after: diskStats,
    selectorSet: {
      missing: diskMissing,
      extra: diskExtra,
      pass: diskMissing.length === 0 && diskExtra.length === 0,
    },
    orderedSequence: {
      beforeLen: seqBefore.length,
      afterLen: diskSeq.length,
      firstMismatch: diskMismatch,
      pass: diskMismatch === -1 && seqBefore.length === diskSeq.length,
    },
    modules: written.map((w) => w.file),
    report: REPORT,
  }, null, 2));

  if (diskMismatch !== -1 || diskMissing.length || diskExtra.length) {
    process.exitCode = 1;
  }
}

main();
