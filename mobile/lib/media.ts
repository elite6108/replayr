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
  const result = await FileSystem.downloadAsync(apiUrl(`/v1/clips/${slug}/download`), dest, { headers });
  if (result.status < 200 || result.status >= 300) {
    throw new Error("Could not download that clip.");
  }
  await MediaLibrary.saveToLibraryAsync(result.uri);
}
