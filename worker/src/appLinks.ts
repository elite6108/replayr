import type { Env } from "./env";

const IOS_BUNDLE_ID = "tv.elite.replay";
const ANDROID_PACKAGE = "tv.elite.replay";

/** apple-app-site-association — no extension, application/json, no redirect. */
export function appleAppSiteAssociation(env: Env): Response {
  const teamId = env.APPLE_TEAM_ID?.trim();
  if (!teamId) {
    return new Response("Apple Team ID is not configured (set APPLE_TEAM_ID).", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const bundleId = env.IOS_BUNDLE_ID?.trim() || IOS_BUNDLE_ID;
  const body = {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: [
            { "/": "/c/*", comment: "Canonical clip share links" },
            { "/": "/clip/*", comment: "Clip path alias" },
          ],
        },
      ],
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

/** Digital Asset Links for Android App Links verification. */
export function androidAssetLinks(env: Env): Response {
  const packageName = env.ANDROID_PACKAGE_NAME?.trim() || ANDROID_PACKAGE;
  const fingerprints = (env.ANDROID_SHA256_CERT_FINGERPRINTS ?? "")
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (fingerprints.length === 0) {
    return new Response(
      "Android signing fingerprints are not configured (set ANDROID_SHA256_CERT_FINGERPRINTS).",
      {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      },
    );
  }
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
