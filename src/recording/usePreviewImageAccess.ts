import { useEffect, useState } from "react";
import { allowPreviewImages } from "../services/tauri";

const granted = new Map<string, Promise<boolean>>();

/**
 * Ask Rust to let the webview read one image file. Images picked in the file dialog are only
 * readable until the app restarts, and imported images never went through the dialog at all.
 */
function allowPreviewImage(path: string): Promise<boolean> {
  const cached = granted.get(path);
  if (cached) return cached;
  const pending = allowPreviewImages([path])
    .then((result) => result[0] === true)
    .catch(() => false);
  granted.set(path, pending);
  void pending.then((ok) => {
    if (!ok) granted.delete(path);
  });
  return pending;
}

/** True once the preview may try to load `path`. A refused path still loads, as it did before. */
export function usePreviewImageAccess(path: string): boolean {
  const [checked, setChecked] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void allowPreviewImage(path).then(() => {
      if (!cancelled) setChecked(path);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return Boolean(path) && checked === path;
}
