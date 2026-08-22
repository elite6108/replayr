import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "web", "public", "releases");
const dest = join(destDir, "Replayr-Setup.exe");
const nsisDirs = [
  join(root, "src-tauri", "target", "release", "bundle", "nsis"),
  process.env.CARGO_TARGET_DIR
    ? join(process.env.CARGO_TARGET_DIR, "release", "bundle", "nsis")
    : null,
];

const sandboxCache = join(process.env.LOCALAPPDATA ?? "", "Temp", "cursor-sandbox-cache");
if (existsSync(sandboxCache)) {
  for (const entry of readdirSync(sandboxCache)) {
    nsisDirs.push(join(sandboxCache, entry, "cargo-target", "release", "bundle", "nsis"));
  }
}

const nsis = nsisDirs.filter(Boolean).find((dir) => existsSync(dir));
if (!nsis) {
  throw new Error("No NSIS bundle yet. Run npm run tauri:build first.");
}

const setup = readdirSync(nsis).find((name) => name.toLowerCase().endsWith("-setup.exe"));
if (!setup) {
  throw new Error(`No setup exe in ${nsis}`);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(join(nsis, setup), dest);
console.log(`Staged ${setup} -> web/public/releases/Replayr-Setup.exe`);
