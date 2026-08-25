/**
 * Creates the Replayr Premium product and prices in the Stripe account
 * whose secret is STRIPE_SECRET_KEY (from the environment or worker/.dev.vars).
 *
 *   node worker/scripts/setup-stripe.mjs
 *
 * Then put the printed price IDs and webhook secret into wrangler secrets:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRICE_PREMIUM_MONTHLY
 *   STRIPE_PRICE_PREMIUM_YEARLY
 * Webhook URL: https://www.replayr.tv/v1/billing/webhook
 * Events: checkout.session.completed, customer.subscription.created,
 * customer.subscription.updated, customer.subscription.deleted,
 * invoice.paid, invoice.payment_failed
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadSecret() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");
  try {
    const text = readFileSync(path, "utf8");
    const line = text.split(/\r?\n/).find((item) => item.startsWith("STRIPE_SECRET_KEY="));
    return line ? line.slice("STRIPE_SECRET_KEY=".length).trim() : "";
  } catch {
    return "";
  }
}

async function stripe(secret, method, path, fields) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: fields ? new URLSearchParams(fields) : undefined,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message || `Stripe ${path} failed`);
  }
  return body;
}

const secret = loadSecret();
if (!secret) {
  console.error("Set STRIPE_SECRET_KEY or add it to worker/.dev.vars, then rerun this script.");
  process.exit(1);
}

const product = await stripe(secret, "POST", "/v1/products", {
  name: "Replayr Premium",
  description: "100 GB cloud, original-quality uploads, no watermark, no ads.",
});
const monthly = await stripe(secret, "POST", "/v1/prices", {
  product: product.id,
  currency: "usd",
  unit_amount: "499",
  "recurring[interval]": "month",
});
const yearly = await stripe(secret, "POST", "/v1/prices", {
  product: product.id,
  currency: "usd",
  unit_amount: "4788",
  "recurring[interval]": "year",
});

console.log("Product", product.id);
console.log("STRIPE_PRICE_PREMIUM_MONTHLY", monthly.id);
console.log("STRIPE_PRICE_PREMIUM_YEARLY", yearly.id);
console.log("Configure Customer Portal in the Stripe dashboard (test and live separately).");
console.log("Webhook: https://www.replayr.tv/v1/billing/webhook");
