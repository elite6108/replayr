import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Share } from "react-native";
import { apiUrl } from "./supabase";
import { suggestedDownloadName } from "./api";

export async function shareClipUrl(url: string) {
  await Share.share({ message: url, url });
}

export async function copyClipUrl(url: string) {
  try {
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(url);
  } catch {
    await Share.share({ message: url, url });
  }
}

export async function saveClipToPhotos(slug: string, title: string | null, accessToken?: string | null) {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (permission.status !== "granted") {
    throw new Error("Photo library permission is required to save clips.");
  }
  if (!FileSystem.cacheDirectory) {
    throw new Error("This device has no cache directory.");
  }
  const dest = `${FileSystem.cacheDirectory}${suggestedDownloadName(title, slug)}`;
  const headers: Record<string, string> = { accept: "application/octet-stream, application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const downloadUrl = apiUrl(`/v1/clips/${slug}/download`);

  let ready = false;
  let lastMessage = "Preparing branded download…";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await fetch(downloadUrl, { headers, redirect: "manual" });
    if (probe.status === 202) {
      try {
        const body = (await probe.json()) as { message?: string };
        if (body.message) lastMessage = body.message;
      } catch {
        /* ignore */
      }
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 4000));
      continue;
    }
    if (probe.status >= 400) {
      let error = "Could not download that clip.";
      try {
        const body = (await probe.json()) as { error?: string };
        if (body.error) error = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(error);
    }
    ready = true;
    try {
      await probe.body?.cancel();
    } catch {
      /* ignore */
    }
    break;
  }
  if (!ready) {
    throw new Error(lastMessage);
  }

  const result = await FileSystem.downloadAsync(downloadUrl, dest, { headers });
  if (result.status === 202) {
    throw new Error(lastMessage);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error("Could not download that clip.");
  }
  // Guard against writing JSON as an MP4 if a 202 slipped through as 200 somehow.
  const info = await FileSystem.getInfoAsync(result.uri);
  if (info.exists && "size" in info && typeof info.size === "number" && info.size < 512) {
    try {
      const text = await FileSystem.readAsStringAsync(result.uri);
      if (text.trim().startsWith("{")) {
        throw new Error(lastMessage);
      }
    } catch (caught) {
      if (caught instanceof Error && caught.message === lastMessage) throw caught;
    }
  }
  await MediaLibrary.saveToLibraryAsync(result.uri);
}
