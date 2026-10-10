import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "artifacts/marketing-screenshots");
const HOST_DIR = "/opt/cursor/artifacts/marketing-screenshots";
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1600, height: 1000 };

const CHROME =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/usr/bin/google-chrome"].find((candidate) =>
    existsSync(candidate),
  );

const MARKETING_CLOUD_CLIPS = [
  {
    id: "cloud-public",
    title: "Untitled clip",
    slug: "public-demo",
    status: "ready",
    visibility: "public",
    durationMs: 54_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 22_400_000,
    createdAt: "2026-09-15T19:40:00.000Z",
    thumbnailUrl: "/thumbs/clip-2.svg",
    playbackUrl: null,
  },
  {
    id: "cloud-unlisted",
    title: "Recording",
    slug: "unlisted-demo",
    status: "ready",
    visibility: "unlisted",
    durationMs: 61_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 28_100_000,
    createdAt: "2026-09-12T20:05:00.000Z",
    thumbnailUrl: "/thumbs/clip-5.svg",
    playbackUrl: null,
  },
  {
    id: "cloud-private",
    title: "Untitled clip",
    slug: "private-demo",
    status: "ready",
    visibility: "private",
    durationMs: 33_000,
    width: 1920,
    height: 1080,
    fileSizeBytes: 16_200_000,
    createdAt: "2026-09-10T11:18:00.000Z",
    thumbnailUrl: "/thumbs/clip-1.svg",
    playbackUrl: null,
  },
];

async function fetchPublicFeed() {
  try {
    const response = await fetch("https://www.replayr.tv/v1/clips/public?limit=24", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { clips: [] };
    const body = await response.json();
    return {
      clips: (body.clips ?? []).map((clip) => ({
        ...clip,
        playbackUrl: null,
      })),
    };
  } catch {
    return { clips: [] };
  }
}

function json(data) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function installRoutes(page, publicFeed) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const api = url.pathname.startsWith("/v1/") || url.hostname.endsWith("replayr.tv");
    if (!api || !url.pathname.includes("/v1/")) {
      await route.continue();
      return;
    }
    const p = url.pathname;
    if (p === "/v1/clips/public") {
      await route.fulfill(json(publicFeed));
      return;
    }
    if (p === "/v1/library") {
      await route.fulfill(json({ clips: MARKETING_CLOUD_CLIPS, total: MARKETING_CLOUD_CLIPS.length }));
      return;
    }
    if (p === "/v1/billing/status") {
      await route.fulfill(
        json({
          plan: "free",
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          complimentary: false,
          watermark: true,
          ads: false,
          storageUsedBytes: 1_240_000_000,
          storageLimitBytes: 5_368_709_120,
          maxClipDurationMs: null,
          maxUploadQuality: null,
          premium: false,
        }),
      );
      return;
    }
    if (p === "/v1/announcements") {
      await route.fulfill(json({ announcements: [] }));
      return;
    }
    if (p === "/v1/folders" || p === "/v1/folders/shared" || p === "/v1/folders/invites") {
      await route.fulfill(json({ folders: [], invites: [] }));
      return;
    }
    if (p === "/v1/clips/friends") {
      await route.fulfill(json({ clips: [] }));
      return;
    }
    if (p === "/v1/following" || p === "/v1/followers") {
      await route.fulfill(json({ users: [] }));
      return;
    }
    if (p === "/v1/follows/requests" || p === "/v1/friends/requests") {
      await route.fulfill(json({ incoming: [], outgoing: [] }));
      return;
    }
    if (p === "/v1/conversations" || p === "/v1/notifications") {
      await route.fulfill(json({ conversations: [], notifications: [] }));
      return;
    }
    if (p.startsWith("/v1/analytics") || p === "/v1/errors") {
      await route.fulfill(json({ ok: true }));
      return;
    }
    await route.fulfill(json({}));
  });
}

async function waitReady(page) {
  await page.waitForSelector("html[data-marketing-ready='1']", { timeout: 20_000 });
  await page.waitForSelector(".app-shell", { timeout: 20_000 });
  await page.waitForTimeout(350);
}

async function shot(page, name) {
  const target = page.locator(".app-shell");
  await target.waitFor({ state: "visible" });
  const file = path.join(OUT_DIR, name);
  await target.screenshot({ path: file, type: "png", animations: "disabled" });
  await mkdir(HOST_DIR, { recursive: true });
  const hostFile = path.join(HOST_DIR, name);
  await target.screenshot({ path: hostFile, type: "png", animations: "disabled" });
  console.log(`wrote ${file}`);
}

async function gotoHash(page, hash) {
  await page.goto(`${ORIGIN}/${hash}`, { waitUntil: "networkidle" });
  await waitReady(page);
}

function startVite() {
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/vite/bin/vite.js"),
      "--config",
      path.join(import.meta.dirname, "vite.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--strictPort",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        VITE_PUBLIC_APP_URL: "https://www.replayr.tv",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return child;
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Vite did not start")), 30_000);
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      if (buf.includes("Local:") || buf.includes("ready in") || buf.includes(String(PORT))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited ${code}\n${buf}`));
    });
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const publicFeed = await fetchPublicFeed();
  const vite = startVite();
  try {
    await waitForServer(vite);
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
    });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    await installRoutes(page, publicFeed);

    await gotoHash(page, "#/record");
    await page.waitForSelector(".record-studio", { timeout: 15_000 });
    await page.evaluate(() => document.fonts?.ready);
    const gameSource = page.getByText("Game Capture", { exact: true }).first();
    if (await gameSource.count()) await gameSource.click();
    await page.waitForTimeout(400);
    await shot(page, "record-preview.png");

    const overlay = page.getByText("Replayr Overlay", { exact: true }).first();
    if (await overlay.count()) {
      await overlay.click();
      await page.waitForSelector(".recording-visuals, .visual-filter-row", { timeout: 8_000 });
      await page.waitForTimeout(250);
      await shot(page, "overlay-pack-or-scene.png");
    }

    await page.getByRole("tab", { name: "Clips" }).click();
    await page.waitForSelector(".studio-ir", { timeout: 15_000 });
    await page.waitForTimeout(350);
    await shot(page, "instant-replay.png");

    await gotoHash(page, "#/library");
    await page.waitForSelector(".clip-card", { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(page, "local-library.png");

    await gotoHash(page, "#/library/cloud");
    await page.waitForSelector(".clip-visibility", { timeout: 15_000 });
    await page.waitForTimeout(400);
    await shot(page, "share-privacy.png");

    await gotoHash(page, "#/explore");
    await page.waitForSelector(".explore-page", { timeout: 15_000 });
    await page.waitForTimeout(900);
    await shot(page, "social-explore-or-following.png");

    await browser.close();
    await writeFile(
      path.join(OUT_DIR, ".capture-meta.json"),
      JSON.stringify(
        {
          publicClipCount: publicFeed.clips.length,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    vite.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
