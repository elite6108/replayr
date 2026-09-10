/**
 * Download a pinned Fixed Version WebView2 runtime into src-tauri/webview2-fixed/
 * so Tauri can bundle it (webviewInstallMode: fixedRuntime).
 *
 * Source: NuGet package WebView2.Runtime.X64 (Fixed Version binaries).
 * Skip download when msedgewebview2.exe is already present unless --force.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

const VERSION = "152.0.4191.62";
const PACKAGE_ID = "webview2.runtime.x64";
const NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/${PACKAGE_ID}/${VERSION}/${PACKAGE_ID}.${VERSION}.nupkg`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", "webview2-fixed");
const cacheDir = join(root, "src-tauri", ".webview2-cache");
const nupkgPath = join(cacheDir, `${PACKAGE_ID}.${VERSION}.nupkg`);
const extractDir = join(cacheDir, `extract-${VERSION}`);
const packageRuntime = join(extractDir, "contentFiles", "any", "any", "WebView2");
const marker = join(destDir, "msedgewebview2.exe");

const force = process.argv.includes("--force");

if (!force && existsSync(marker)) {
  console.log(`WebView2 fixed runtime already present: ${destDir}`);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });

if (force || !existsSync(nupkgPath)) {
  console.log(`Downloading ${NUPKG_URL}`);
  const res = await fetch(NUPKG_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(nupkgPath));
  console.log(`Saved ${nupkgPath}`);
} else {
  console.log(`Using cached ${nupkgPath}`);
}

rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

// nupkg is zip; prefer tar on Windows/macOS/Linux (Node 22+ / system tar).
try {
  execFileSync("tar", ["-xf", nupkgPath, "-C", extractDir], { stdio: "inherit" });
} catch {
  // Fallback: PowerShell Expand-Archive after renaming to .zip
  const zipPath = `${nupkgPath}.zip`;
  cpSync(nupkgPath, zipPath);
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
    { stdio: "inherit" },
  );
}

if (!existsSync(join(packageRuntime, "msedgewebview2.exe"))) {
  throw new Error(`Extracted package missing msedgewebview2.exe under ${packageRuntime}`);
}

rmSync(destDir, { recursive: true, force: true });
mkdirSync(dirname(destDir), { recursive: true });
cpSync(packageRuntime, destDir, { recursive: true });

const files = readdirSync(destDir);
console.log(`Staged Fixed Version ${VERSION} → ${destDir} (${files.length} entries)`);
console.log("Ready for tauri build (bundle.windows.webviewInstallMode.fixedRuntime).");
