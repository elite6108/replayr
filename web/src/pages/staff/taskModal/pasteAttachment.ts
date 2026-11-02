const PASTE_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type PasteItem = { kind: string; type: string; getAsFile: () => File | null };

type PasteData = {
  items?: ArrayLike<PasteItem>;
  files?: ArrayLike<File>;
  getData?: (type: string) => string;
};

/** Image files from a paste. Clipboard screenshots often have no filename. */
export function filesFromImagePaste(data: PasteData | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const mime = item.type.toLowerCase().split(";")[0]?.trim() ?? "";
    if (!PASTE_IMAGE_EXT[mime]) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(namedPasteImage(file, mime));
  }
  if (fromItems.length) return fromItems;
  const fromFiles: File[] = [];
  for (const file of Array.from(data.files ?? [])) {
    const mime = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
    if (!PASTE_IMAGE_EXT[mime]) continue;
    fromFiles.push(namedPasteImage(file, mime));
  }
  return fromFiles;
}

export function pasteHasPlainText(data: PasteData | null): boolean {
  return Boolean(data?.getData?.("text/plain")?.trim());
}

/** Files to upload. An empty list means the paste should stay in a text field. */
export function attachmentFilesFromPaste(data: PasteData | null, target: EventTarget | null): File[] {
  const images = filesFromImagePaste(data);
  if (!images.length) return [];
  if (isTextTarget(target) && pasteHasPlainText(data)) return [];
  return images;
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

function namedPasteImage(file: File, mime: string): File {
  const ext = PASTE_IMAGE_EXT[mime];
  const current = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const matches = mime === "image/jpeg" ? current === "jpg" || current === "jpeg" : current === ext;
  if (matches && file.type.toLowerCase().split(";")[0]?.trim() === mime) return file;
  const name = matches ? file.name : `pasted-image.${ext}`;
  return new File([file], name, { type: mime });
}
