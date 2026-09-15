import { useEffect, useState } from "react";
import logoMark from "../../assets/replayr-mark.png";

export type OverlayKind = "clipSaved" | "screenshot";

/** Hand-mirrored with `ScreenshotNotice` in src-tauri/src/overlay_notification.rs. */
export type ScreenshotNotice = "linkCopied" | "linkCopiedReplacedOldest" | "imageCopied" | "uploadFailedImageCopied";

export interface OverlayShowPayload {
  kind: OverlayKind;
  durationSeconds?: number | null;
  screenshot?: ScreenshotNotice | null;
  generation: number;
}

interface OverlayCopy {
  title: string;
  subtitle: string | null;
}

function durationLabel(seconds?: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  return `Last ${seconds} seconds`;
}

/** Keep in step with `screenshot_copy` in overlay_notification.rs, which is the OS-toast fallback. */
function screenshotCopy(notice: ScreenshotNotice | null | undefined): OverlayCopy {
  switch (notice) {
    case "linkCopied":
      return { title: "Link copied", subtitle: null };
    case "linkCopiedReplacedOldest":
      return { title: "Link copied", subtitle: "Replaced your oldest screenshot" };
    case "uploadFailedImageCopied":
      return { title: "Upload failed", subtitle: "Image copied instead" };
    default:
      return { title: "Screenshot copied", subtitle: null };
  }
}

function copyFor(payload: OverlayShowPayload): OverlayCopy {
  if (payload.kind === "screenshot") return screenshotCopy(payload.screenshot);
  return { title: "Clip saved", subtitle: durationLabel(payload.durationSeconds) };
}

export function ClipSavedOverlay() {
  const preview = new URLSearchParams(window.location.search).has("preview");
  const [visible, setVisible] = useState(preview);
  const [copy, setCopy] = useState<OverlayCopy>(
    preview ? { title: "Clip saved", subtitle: durationLabel(30) } : { title: "Clip saved", subtitle: null },
  );

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        if (cancelled) return;
        unlisteners.push(
          await listen<OverlayShowPayload>("overlay-show", (event) => {
            if (event.payload.kind !== "clipSaved" && event.payload.kind !== "screenshot") return;
            setCopy(copyFor(event.payload));
            setVisible(true);
          }),
        );
        unlisteners.push(
          await listen("overlay-hide", () => {
            setVisible(false);
          }),
        );
      })
      .catch(() => {
        /* Overlay is running outside Tauri; stay hidden unless preview. */
      });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [preview]);

  return (
    <div className={`clip-saved${visible ? " is-visible" : ""}`} role="status" aria-live="polite">
      <span className="clip-saved-accent" aria-hidden="true" />
      <img className="clip-saved-logo" src={logoMark} width={28} height={28} alt="" />
      <div className="clip-saved-copy">
        <div className="clip-saved-title">{copy.title}</div>
        {copy.subtitle ? <div className="clip-saved-subtitle">{copy.subtitle}</div> : null}
      </div>
    </div>
  );
}
