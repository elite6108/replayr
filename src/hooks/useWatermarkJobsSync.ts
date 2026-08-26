import { useEffect } from "react";
import { publicAppUrl } from "../branding";
import { processWatermarkJobs, syncWatermarkJobs } from "../services/tauri";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";

const RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Keeps burned-in watermarked download derivatives flowing in the background.
 * On sign-in it reconciles with the Worker (clips whose derivative is missing,
 * failed, or rendered with a stale version) and then works through the local
 * queue; the interval retries failed jobs with their backoff.
 */
export function useWatermarkJobsSync() {
  const accessToken = useAuthStore((state) => state.session?.access_token ?? null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    async function run(sync: boolean) {
      const token = useAuthStore.getState().session?.access_token;
      if (!token || cancelled) return;
      try {
        if (sync) await syncWatermarkJobs(token, publicAppUrl());
        const completed = await processWatermarkJobs(token, publicAppUrl());
        if (completed > 0 && !cancelled) {
          await useCloudStore.getState().refresh();
        }
      } catch (caught) {
        console.warn("watermark jobs", caught);
      }
    }

    void run(true);
    const timer = window.setInterval(() => void run(false), RETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken]);
}
