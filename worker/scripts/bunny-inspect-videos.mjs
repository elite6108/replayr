import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = {};
for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 1) continue;
  env[t.slice(0, i)] = t.slice(i + 1).trim();
}

const lib = env.BUNNY_STREAM_LIBRARY_ID;
const key = env.BUNNY_STREAM_API_KEY;
const cdn = String(env.BUNNY_STREAM_CDN_HOSTNAME || "")
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

const ids = [
  "69bfffac-0f6d-4a61-a2b3-866e615561f7",
  "9b9c7516-5bac-43f9-a439-0b4935faf0f9",
];

for (const id of ids) {
  const video = await bunny(`/videos/${id}`);
  const resolutions = await bunny(`/videos/${id}/resolutions`);
  console.log(
    JSON.stringify(
      {
        id,
        status: video.status,
        width: video.width,
        height: video.height,
        hasMP4Fallback: video.hasMP4Fallback,
        availableResolutions: video.availableResolutions,
        mp4Resolutions: resolutions.mp4Resolutions,
        available: resolutions.availableResolutions,
      },
      null,
      2,
    ),
  );
  for (const res of [1080, 720, 480]) {
    const url = `https://${cdn}/${id}/play_${res}p.mp4`;
    const head = await fetch(url, { method: "HEAD" });
    console.log(
      `HEAD ${res}p -> ${head.status} len=${head.headers.get("content-length")} type=${head.headers.get("content-type")}`,
    );
  }
}

async function bunny(path) {
  const response = await fetch(`https://video.bunnycdn.com/library/${lib}${path}`, {
    headers: { AccessKey: key, accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status} ${text}`);
  return JSON.parse(text);
}
