import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {
  ...readEnv(join(root, ".env")),
  ...readEnv(join(root, ".env.cloudflare")),
};

const accountId =
  env.R2_ACCOUNT_ID ||
  (env.R2_ENDPOINT?.match(/^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i)?.[1] ?? "");

const secrets = {
  SUPABASE_URL: env.VITE_SUPABASE_URL || env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || "",
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET_NAME: env.R2_BUCKET_NAME || "",
};
if (env.SUPABASE_SERVICE_ROLE_KEY) {
  secrets.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
} else {
  console.warn("SUPABASE_SERVICE_ROLE_KEY missing — admin API will stay disabled in production.");
}

const missing = Object.entries(secrets)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Fill .env and .env.cloudflare first.`);
  process.exit(1);
}

const file = join(mkdtempSync(join(tmpdir(), "replayr-secrets-")), "secrets.env");
writeFileSync(
  file,
  Object.entries(secrets)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);

const result = spawnSync("npx", ["wrangler", "secret", "bulk", file], {
  cwd: join(root, "worker"),
  stdio: "inherit",
  shell: true,
});
unlinkSync(file);
process.exit(result.status ?? 1);

function readEnv(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      if (split < 1) continue;
      out[trimmed.slice(0, split)] = trimmed.slice(split + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}
