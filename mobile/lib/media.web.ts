export async function copyClipUrl(url: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    return;
  }
  await shareClipUrl(url);
}

export async function shareClipUrl(url: string) {
  if (typeof navigator !== "undefined" && navigator.share) {
    await navigator.share({ url, text: url });
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    return;
  }
  throw new Error(url);
}

export async function saveClipToPhotos(_slug?: string, _title?: string | null, _accessToken?: string | null) {
  throw new Error("Save to Photos is available in the iOS and Android apps.");
}
