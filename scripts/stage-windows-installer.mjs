import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "web", "public", "releases");
const destExe = join(destDir, "Replayr.exe");
const destLatest = join(destDir, "latest.json");
const downloadUrl = "https://www.replayr.tv/releases/Replayr.exe";
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

const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = typeof tauriConf.version === "string" && tauriConf.version ? tauriConf.version : pkg.version;

const setups = nsisDirs
  .filter((dir) => dir && existsSync(dir))
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith("-setup.exe"))
      .map((name) => ({ dir, name, path: join(dir, name) })),
  );
if (setups.length === 0) {
  throw new Error("No NSIS setup exe yet. Run npm run tauri:build first.");
}

const preferred = setups.find((item) => item.name.includes(version));
const setup = preferred
  ?? setups
    .slice()
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)[0];

mkdirSync(destDir, { recursive: true });
copyFileSync(setup.path, destExe);
console.log(`Staged ${setup.name} -> web/public/releases/Replayr.exe`);

const nsisSig = join(setup.dir, `${setup.name}.sig`);
const destSig = `${destExe}.sig`;
const sigPath = existsSync(nsisSig) ? nsisSig : destSig;
if (existsSync(nsisSig) && sigPath !== destSig) {
  copyFileSync(nsisSig, destSig);
}
if (!existsSync(sigPath)) {
  throw new Error(
    `Missing updater signature at ${nsisSig} and ${destSig}. Sign with: npx @tauri-apps/cli signer sign --private-key-path .tauri/updater.key --password= -- web/public/releases/Replayr.exe`,
  );
}

const signature = readFileSync(sigPath, "utf8").trim();
if (!signature) {
  throw new Error(`Updater signature file ${sigPath} is empty.`);
}

const latest = {
  version,
  notes: `Replayr ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      url: downloadUrl,
      signature,
    },
  },
};

writeFileSync(destLatest, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Wrote web/public/releases/latest.json for ${version}`);
