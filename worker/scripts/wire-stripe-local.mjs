/**
 * Uses a logged-in Stripe CLI to create Replayr Premium prices (test mode)
 * and write STRIPE_* into worker/.dev.vars without printing secrets.
 *
 *   node worker/scripts/wire-stripe-local.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = join(root, ".dev.vars");
const stripeBin = process.env.STRIPE_BIN || "stripe";

function stripe(args) {
  return execFileSync(stripeBin, args, { encoding: "utf8" }).trim();
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 1) continue;
    out[trimmed.slice(0, split)] = trimmed.slice(split + 1).trim();
  }
  return out;
}

function configValue(key) {
  const listed = stripe(["config", "--list"]);
  const match = listed.match(new RegExp(`(?:^|\\n)${key}\\s*=\\s*'([^']+)'`));
  return match?.[1] || "";
}

function findPrice(productId, interval) {
  const body = JSON.parse(stripe(["prices", "list", "--product", productId, "--limit", "20"]));
  return (body.data || []).find(
    (price) => price.recurring?.interval === interval && price.active !== false,
  );
}

const secret = configValue("test_mode_api_key");
if (!secret) {
  console.error("Stripe CLI is not logged in for test mode. Run: stripe login");
  process.exit(1);
}

let productId = "";
const products = JSON.parse(stripe(["products", "list", "--limit", "20"]));
const existing = (products.data || []).find((item) => item.name === "Replayr Premium");
if (existing) {
  productId = existing.id;
} else {
  const created = JSON.parse(
    stripe([
      "products",
      "create",
      "-c",
      "--name",
      "Replayr Premium",
      "--description",
      "100 GB cloud, original-quality uploads, no watermark, no ads.",
    ]),
  );
  productId = created.id;
}

let monthly = findPrice(productId, "month");
if (!monthly) {
  monthly = JSON.parse(
    stripe([
      "prices",
      "create",
      "-c",
      "--product",
      productId,
      "--currency",
      "usd",
      "--unit-amount",
      "499",
      "--recurring.interval",
      "month",
    ]),
  );
}

let yearly = findPrice(productId, "year");
if (!yearly) {
  yearly = JSON.parse(
    stripe([
      "prices",
      "create",
      "-c",
      "--product",
      productId,
      "--currency",
      "usd",
      "--unit-amount",
      "4788",
      "--recurring.interval",
      "year",
    ]),
  );
}

let webhookSecret = "";
try {
  webhookSecret = stripe(["listen", "--print-secret"]);
} catch {
  webhookSecret = "";
}

const current = existsSync(devVarsPath) ? parseEnv(readFileSync(devVarsPath, "utf8")) : {};
current.STRIPE_SECRET_KEY = secret;
current.STRIPE_PRICE_PREMIUM_MONTHLY = monthly.id;
current.STRIPE_PRICE_PREMIUM_YEARLY = yearly.id;
if (webhookSecret) current.STRIPE_WEBHOOK_SECRET = webhookSecret;

const body = Object.entries(current)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n");
writeFileSync(devVarsPath, `${body}\n`);

console.log("Wrote Stripe test keys to worker/.dev.vars");
console.log("product", productId);
console.log("monthly", monthly.id);
console.log("yearly", yearly.id);
console.log("webhook_secret", webhookSecret ? "cli-listen" : "missing");
