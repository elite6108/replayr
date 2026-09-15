import { publicApiUrl } from "../branding";
import { formatBytes } from "../utils/format";

export interface ScreenshotUsage {
  count: number;
  bytes: number;
  countLimit: number | null;
  bytesLimit: number | null;
  trimAfter: string | null;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let body: { error?: string } = {};
  try {
    body = text ? (JSON.parse(text) as { error?: string }) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || fallback);
  return body as T;
}

export async function fetchScreenshotUsage(accessToken: string): Promise<ScreenshotUsage> {
  const response = await fetch(`${publicApiUrl()}/v1/screenshots/usage`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  return readJson<ScreenshotUsage>(response, "Could not load screenshot usage.");
}

export function screenshotUsageLabel(usage: ScreenshotUsage): string {
  if (usage.countLimit != null) {
    return `${usage.count} / ${usage.countLimit} images`;
  }
  if (usage.bytesLimit != null) {
    return `${formatBytes(usage.bytes)} / ${formatBytes(usage.bytesLimit)}`;
  }
  return `${usage.count} images`;
}

export function screenshotUsagePercent(usage: ScreenshotUsage): number {
  if (usage.countLimit != null && usage.countLimit > 0) {
    return Math.min(100, (usage.count / usage.countLimit) * 100);
  }
  if (usage.bytesLimit != null && usage.bytesLimit > 0) {
    return Math.min(100, (usage.bytes / usage.bytesLimit) * 100);
  }
  return 0;
}
