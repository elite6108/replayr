import type { CloudClip, LocalClip } from "../types/clip";
import { publicApiUrl } from "../branding";
import {
  downloadUrlToFile,
  getDefaultSaveLocation,
  importLinkedCloudClip,
  localCopyForCloud,
} from "../services/tauri";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import { waitForCloudDownloadReady } from "../utils/cloudDownload";
import { invokeErrorMessage } from "../utils/format";
import { joinPath, suggestedFileName } from "../utils/files";

const preparing = new Set<string>();

function rememberLocal(clip: LocalClip) {
  const rest = useLibraryStore.getState().clips.filter((item) => item.localId !== clip.localId);
  useLibraryStore.setState({ clips: [clip, ...rest], loaded: true });
}

function editFileName(title: string | null): string {
  const base = suggestedFileName(title, "clip", "mp4").replace(/\.mp4$/i, "");
  return `${base}-${Date.now().toString().slice(-6)}.mp4`;
}

/** Open the editor for a ready cloud clip, downloading it onto this PC only when no local file remains. */
export async function editCloudClip(clip: CloudClip, open: (path: string) => void): Promise<void> {
  if (clip.status !== "ready") {
    useToastStore.getState().show("That clip is not ready to edit");
    return;
  }
  if (preparing.has(clip.id)) return;
  preparing.add(clip.id);
  try {
    const linked = await localCopyForCloud(clip.id);
    if (linked) {
      rememberLocal(linked);
      open(`/editor/${linked.localId}`);
      return;
    }

    const token = useAuthStore.getState().session?.access_token;
    if (!token) {
      useToastStore.getState().show("Sign in to edit a cloud clip");
      return;
    }

    const configured = useSettingsStore.getState().settings.saveLocation.trim();
    const dir = configured || (await getDefaultSaveLocation());
    if (!dir.trim()) {
      useToastStore.getState().show("Choose a save folder in Settings first");
      return;
    }

    const freeTier = useBillingStore.getState().status?.watermark !== false;
    const upgradeHint = freeTier
      ? " Upgrade to Premium for instant downloads without watermarks."
      : "";
    useToastStore.getState().show(`Preparing this clip for editing…${upgradeHint}`);

    const downloadUrl = `${publicApiUrl()}/v1/clips/${clip.slug}/download`;
    await waitForCloudDownloadReady(downloadUrl, token, {
      onProgress: (update) => {
        if (update.attempt === 1 || update.attempt % 3 === 0 || update.progress >= 1) {
          useToastStore.getState().show(
            update.progress >= 1 ? "Starting download…" : `${update.message}${upgradeHint}`,
          );
        }
      },
    });
    const dest = joinPath(dir, editFileName(clip.title));
    await downloadUrlToFile(downloadUrl, dest, { skipWatermark: true, accessToken: token });
    const imported = await importLinkedCloudClip({
      path: dest,
      title: clip.title?.trim() || "Untitled clip",
      cloudClipId: clip.id,
      durationMs: Math.max(0, Math.round(clip.durationMs ?? 0)),
      width: Math.max(0, Math.round(clip.width ?? 0)),
      height: Math.max(0, Math.round(clip.height ?? 0)),
    });
    await useLibraryStore.getState().refresh();
    if (!useLibraryStore.getState().clips.some((item) => item.localId === imported.localId)) {
      rememberLocal(imported);
    }
    open(`/editor/${imported.localId}`);
  } catch (caught) {
    useToastStore.getState().show(invokeErrorMessage(caught, "Could not open that clip for editing"));
  } finally {
    preparing.delete(clip.id);
  }
}
