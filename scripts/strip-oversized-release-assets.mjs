/**
 * Workers Assets max file size is 25 MiB. Fat Fixed-WebView2 Windows installers
 * are hosted on GitHub Releases instead — strip them from dist before deploy.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 24 * 1024 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  join(root, "web", "dist", "releases", "Replayr.exe"),
  join(root, "web", "dist", "releases", "Replayr.dmg"),
];

for (const path of targets) {
  if (!existsSync(path)) continue;
  const size = statSync(path).size;
  if (size <= MAX_BYTES) continue;
  rmSync(path);
  console.log(`Removed oversized Workers asset ${path} (${(size / (1024 * 1024)).toFixed(1)} MiB)`);
}
