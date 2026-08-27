import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {
  ...parseEnv(join(root, ".env")),
  ...parseEnv(join(root, ".env.cloudflare")),
};

const accountId =
  env.R2_ACCOUNT_ID ||
  (env.R2_ENDPOINT?.match(/^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i)?.[1] ?? "");

const existing = parseEnv(join(root, "worker", ".dev.vars"));
const vars = {
  SUPABASE_URL: env.VITE_SUPABASE_URL || env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || "",
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET_NAME: env.R2_BUCKET_NAME || "",
  PUBLIC_APP_URL: "http://127.0.0.1:8787",
};
for (const key of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PREMIUM_MONTHLY",
  "STRIPE_PRICE_PREMIUM_YEARLY",
  "BUNNY_STREAM_LIBRARY_ID",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_STREAM_CDN_HOSTNAME",
  "BUNNY_STREAM_READONLY_API_KEY",
  "BUNNY_STREAM_TOKEN_AUTH_KEY",
]) {
  const value = env[key] || existing[key];
  if (value) vars[key] = value;
}
if (env.SUPABASE_SERVICE_ROLE_KEY) {
  vars.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
} else {
  console.warn(
    "SUPABASE_SERVICE_ROLE_KEY is missing. Admin routes will stay disabled until you add it to .env (not VITE_) and restart the Worker.",
  );
}

const missing = Object.entries(vars)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Fill .env and .env.cloudflare first.`);
  process.exit(1);
}

const body = Object.entries(vars)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n");
writeFileSync(join(root, "worker", ".dev.vars"), `${body}\n`);
console.log(`Wrote worker/.dev.vars (${Object.keys(vars).join(", ")})`);

function parseEnv(path) {
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
