/**
 * Upload staged web/public/releases/Replayr.exe to the rolling `windows` GitHub Release.
 * Workers Assets cannot host Fixed-WebView2 builds (>25 MiB).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "web", "public", "releases", "Replayr.exe");
const tag = "windows";

if (!existsSync(exe)) {
  throw new Error(`Missing ${exe}. Run npm run installer:stage first.`);
}

function gh(args) {
  return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let releaseExists = true;
try {
  gh(["release", "view", tag]);
} catch {
  releaseExists = false;
}

if (!releaseExists) {
  console.log(`Creating GitHub release ${tag}`);
  gh([
    "release",
    "create",
    tag,
    exe,
    "--title",
    "Replayr for Windows",
    "--notes",
    "Current Windows installer (includes Fixed Version WebView2). The site serves this at https://www.replayr.tv/releases/Replayr.exe",
    "--latest=false",
  ]);
} else {
  console.log(`Uploading ${exe} to GitHub release ${tag} (clobber)`);
  try {
    gh(["release", "delete-asset", tag, "Replayr.exe", "--yes"]);
  } catch {
    // Asset may not exist yet.
  }
  gh(["release", "upload", tag, exe, "--clobber"]);
}

console.log(`Published ${tag}: https://github.com/elite6108/replayr/releases/download/windows/Replayr.exe`);
