import type { RecordingSourceType } from "../../recording/scene";

export function SourceGlyph({ type }: { type: RecordingSourceType }) {
  return <span className="studio-source-glyph" aria-hidden="true">{glyph(type)}</span>;
}

function glyph(type: RecordingSourceType) {
  if (type === "webcam") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M4 8.5h11.5A1.5 1.5 0 0 1 17 10v4a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 14v-4A1.5 1.5 0 0 1 4 8.5z" />
        <path d="m17 10.5 4.5-2v7l-4.5-2z" />
      </svg>
    );
  }
  if (type === "microphone") {
    return (
      <svg viewBox="0 0 24 24">
        <rect x="9" y="3.5" width="6" height="10" rx="3" />
        <path d="M7 11.5a5 5 0 0 0 10 0M12 16.5v3.5M9 20.5h6" />
      </svg>
    );
  }
  if (type === "desktopAudio" || type === "gameAudio") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M10 8.5 6.5 11H4v2h2.5L10 15.5z" />
        <path d="M14.2 8.8a4.2 4.2 0 0 1 0 6.4M16.6 6.6a7.4 7.4 0 0 1 0 10.8" />
      </svg>
    );
  }
  if (type === "image") {
    return (
      <svg viewBox="0 0 24 24">
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.4" />
        <path d="m7 16 3.4-3.4 2.2 2.2L16 11l3 5" />
      </svg>
    );
  }
  if (type === "text") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M6 7h12M12 7v11M8 18h8" />
      </svg>
    );
  }
  if (type === "replayrOverlay") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M12 3.5 13.8 8h4.7l-3.8 2.9 1.4 4.6L12 13.3 7.9 15.5 9.3 10.9 5.5 8h4.7z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24">
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
      <path d="M8 15.5 10.4 12l2.2 2.4 2-2.6 3.4 3.7" />
    </svg>
  );
}
