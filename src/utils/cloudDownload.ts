/** Poll GET /v1/clips/:slug/download until the branded MP4 is ready (or fails). */

export class DownloadPreparingError extends Error {
  constructor(message = "Preparing branded download…") {
    super(message);
    this.name = "DownloadPreparingError";
  }
}

export type CloudDownloadReady =
  | { kind: "stream" }
  | { kind: "redirect"; location: string };

export type DownloadProgress = {
  attempt: number;
  attempts: number;
  message: string;
  /** 0–1 estimate while waiting for Bunny. */
  progress: number;
};

/** Polls until ready. Bunny encode often takes >30s — default ~3 minutes. */
export async function waitForCloudDownloadReady(
  downloadUrl: string,
  accessToken: string | null | undefined,
  options?: {
    attempts?: number;
    delayMs?: number;
    onProgress?: (update: DownloadProgress) => void;
  },
): Promise<CloudDownloadReady> {
  const attempts = options?.attempts ?? 36;
  const delayMs = options?.delayMs ?? 5000;
  const headers: HeadersInit = { accept: "application/octet-stream, application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let lastMessage = "Download will begin within about 30 seconds…";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options?.onProgress?.({
      attempt: attempt + 1,
      attempts,
      message: lastMessage,
      // Ease toward ~90% over the first ~30s of polls, then creep while still waiting.
      progress: Math.min(0.92, 0.15 + (attempt / Math.min(attempts, 8)) * 0.75),
    });
    const response = await fetch(downloadUrl, { headers, redirect: "manual" });
    if (response.status === 202) {
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) lastMessage = body.message;
      } catch {
        /* ignore */
      }
      lastMessage =
        attempt < 6
          ? "Download will begin within about 30 seconds…"
          : "Still preparing your branded download…";
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      continue;
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || "Branded download is unavailable for this clip.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Could not download that clip.");
      options?.onProgress?.({
        attempt: attempt + 1,
        attempts,
        message: "Starting download…",
        progress: 1,
      });
      return { kind: "redirect", location };
    }
    if (response.status >= 200 && response.status < 300) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      options?.onProgress?.({
        attempt: attempt + 1,
        attempts,
        message: "Starting download…",
        progress: 1,
      });
      return { kind: "stream" };
    }
    let error = `Could not download that clip (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) error = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(error);
  }
  throw new DownloadPreparingError(lastMessage);
}
