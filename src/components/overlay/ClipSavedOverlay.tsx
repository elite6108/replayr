import { useEffect, useState } from "react";
import logoMark from "../../assets/replayr-mark.png";

export type OverlayKind = "clipSaved";

export interface OverlayShowPayload {
  kind: OverlayKind;
  durationSeconds?: number | null;
  generation: number;
}

function durationLabel(seconds?: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  return `Last ${seconds} seconds`;
}

export function ClipSavedOverlay() {
  const preview = new URLSearchParams(window.location.search).has("preview");
  const [visible, setVisible] = useState(preview);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(preview ? 30 : null);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        if (cancelled) return;
        unlisteners.push(
          await listen<OverlayShowPayload>("overlay-show", (event) => {
            if (event.payload.kind !== "clipSaved") return;
            setDurationSeconds(event.payload.durationSeconds ?? null);
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

  const subtitle = durationLabel(durationSeconds);

  return (
    <div className={`clip-saved${visible ? " is-visible" : ""}`} role="status" aria-live="polite">
      <span className="clip-saved-accent" aria-hidden="true" />
      <img className="clip-saved-logo" src={logoMark} width={28} height={28} alt="" />
      <div className="clip-saved-copy">
        <div className="clip-saved-title">Clip saved</div>
        {subtitle ? <div className="clip-saved-subtitle">{subtitle}</div> : null}
      </div>
    </div>
  );
}
