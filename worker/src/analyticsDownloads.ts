import { observeCountedAnalytics } from "./analytics";
import { captureAnonymousFromEvent, isSafeAnonymousId, parseReplayrAnonymousId } from "./analyticsAcquisition";
import { SERVER_ANALYTICS_EVENTS } from "./analyticsDictionary";
import type { Env } from "./env";

export const INSTALLER_ARTIFACTS: Record<string, { platform: "windows" | "macos"; filename: string }> = {
  "/releases/Replayr.exe": { platform: "windows", filename: "Replayr.exe" },
  "/releases/Replayr.dmg": { platform: "macos", filename: "Replayr.dmg" },
};

/** Stable GitHub Release asset. CI updates the `macos` tag; Workers Assets is optional. */
export const MAC_DMG_RELEASE_URL = "https://github.com/elite6108/replayr/releases/download/macos/Replayr.dmg";

export function installerArtifact(pathname: string) {
  return INSTALLER_ARTIFACTS[pathname] ?? null;
}

/**
 * Real installer bytes — not the marketing SPA. Workers Assets SPA fallback
 * returns 200 text/html when Replayr.dmg is missing.
 */
export function isInstallerPayload(response: Response): boolean {
  if (response.status !== 200 && response.status !== 206) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (
    type.includes("text/html") ||
    type.includes("text/javascript") ||
    type.includes("application/javascript") ||
    type.includes("application/json") ||
    type.includes("text/css")
  ) {
    return false;
  }
  return true;
}

/**
 * Count a successful full-file installer GET.
 * HEAD does not transfer the file.
 * latest.json is not an installer.
 * Resume Range requests (bytes>0) are not a new download.
 * 206 partials are not counted — avoids retry inflation.
 * 302 to the published GitHub DMG counts as a completed handoff.
 */
export function shouldCountInstallerDownload(request: Request, response: Response): boolean {
  if (request.method !== "GET") return false;
  if (response.status !== 200 && response.status !== 302) return false;
  if (response.status === 200 && !isInstallerPayload(response)) return false;
  const range = (request.headers.get("range") || "").trim();
  if (range && !/^bytes=0-/i.test(range)) return false;
  return true;
}

function countInstaller(request: Request, env: Env, artifact: { platform: "windows" | "macos"; filename: string }) {
  const anonymousId = parseReplayrAnonymousId(request.headers.get("cookie"));
  observeCountedAnalytics(env, SERVER_ANALYTICS_EVENTS.installerDownloaded, {
    anonymousId: isSafeAnonymousId(anonymousId) ? anonymousId : null,
    properties: {
      platform: artifact.platform,
      artifact: artifact.filename,
    },
  });
  if (isSafeAnonymousId(anonymousId)) {
    captureAnonymousFromEvent(env, { anonymousId, installer: true });
  }
}

export async function macDmgReleaseAvailable(
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(MAC_DMG_RELEASE_URL, { method: "HEAD", redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

function installerMissing() {
  return new Response(JSON.stringify({ error: "Installer is not published." }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache, must-revalidate",
    },
  });
}

export async function serveInstallerDownload(
  request: Request,
  env: Env,
  pathname: string,
  fetchAsset: (request: Request) => Promise<Response>,
  wrap: (response: Response) => Response,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const artifact = installerArtifact(pathname);
  if (!artifact) return null;
  const asset = await fetchAsset(request);
  if (isInstallerPayload(asset)) {
    const response = wrap(asset);
    if (shouldCountInstallerDownload(request, response)) {
      countInstaller(request, env, artifact);
    }
    return response;
  }
  if (artifact.platform === "macos" && (await macDmgReleaseAvailable(fetchImpl))) {
    const response = wrap(
      new Response(null, {
        status: 302,
        headers: {
          location: MAC_DMG_RELEASE_URL,
          "cache-control": "no-cache, must-revalidate",
        },
      }),
    );
    if (shouldCountInstallerDownload(request, response)) {
      countInstaller(request, env, artifact);
    }
    return response;
  }
  return wrap(installerMissing());
}

export function recordClipDownloadEvent(
  env: Env,
  input: { clipId: string; ownerId?: string | null; viewerId?: string | null },
): void {
  const authenticated = Boolean(input.viewerId);
  observeCountedAnalytics(
    env,
    authenticated ? SERVER_ANALYTICS_EVENTS.clipDownloaded : SERVER_ANALYTICS_EVENTS.clipPublicDownloaded,
    {
      userId: input.viewerId ?? null,
      properties: {
        clip_id: input.clipId,
        authenticated,
      },
    },
  );
}

export function recordFolderPublicDownloadEvent(
  env: Env,
  input: { folderId: string; clipId: string; ownerId?: string | null },
): void {
  observeCountedAnalytics(env, SERVER_ANALYTICS_EVENTS.folderPublicDownloaded, {
    properties: {
      folder_id: input.folderId,
      clip_id: input.clipId,
      authenticated: false,
    },
  });
}
