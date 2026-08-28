/**
 * Stage a macOS DMG into the marketing site releases folder.
 *
 * Does not touch the Windows NSIS installer or latest.json Windows channel.
 *
 * Usage (on macOS after a DMG build):
 *   npm run tauri:build:macos
 *   npm run installer:stage:macos
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "web", "public", "releases");
const destDmg = join(destDir, "Replayr.dmg");
const downloadUrl = "https://www.replayr.tv/releases/Replayr.dmg";

const dmgDirs = [
  join(root, "src-tauri", "target", "release", "bundle", "dmg"),
  join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "dmg"),
  join(root, "src-tauri", "target", "x86_64-apple-darwin", "release", "bundle", "dmg"),
  join(root, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "dmg"),
];

if (process.env.CARGO_TARGET_DIR) {
  dmgDirs.push(
    join(process.env.CARGO_TARGET_DIR, "release", "bundle", "dmg"),
    join(process.env.CARGO_TARGET_DIR, "aarch64-apple-darwin", "release", "bundle", "dmg"),
    join(process.env.CARGO_TARGET_DIR, "x86_64-apple-darwin", "release", "bundle", "dmg"),
    join(process.env.CARGO_TARGET_DIR, "universal-apple-darwin", "release", "bundle", "dmg"),
  );
}

const dmgs = dmgDirs
  .filter((dir) => existsSync(dir))
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".dmg"))
      .map((name) => ({ dir, name, path: join(dir, name) })),
  );

if (dmgs.length === 0) {
  throw new Error(
    "No macOS DMG found. On a Mac run: npm run tauri:build:macos\n" +
      "Expected under src-tauri/target/**/release/bundle/dmg/*.dmg",
  );
}

const dmg = dmgs
  .slice()
  .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0];

mkdirSync(destDir, { recursive: true });
copyFileSync(dmg.path, destDmg);
console.log(`Staged ${dmg.name} -> web/public/releases/Replayr.dmg`);
console.log(`Public URL: ${downloadUrl}`);

const marker = join(destDir, "Replayr.dmg.txt");
writeFileSync(
  marker,
  [
    `source=${dmg.path}`,
    `staged_at=${new Date().toISOString()}`,
    `url=${downloadUrl}`,
    "",
  ].join("\n"),
);
