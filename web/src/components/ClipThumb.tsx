import { useEffect, useState } from "react";

export function ClipThumb({
  title,
  thumbnailUrl,
  playbackUrl,
}: {
  title: string;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [thumbnailUrl, playbackUrl]);

  if (thumbnailUrl && !failed) {
    return <img src={thumbnailUrl} alt="" onError={() => setFailed(true)} />;
  }
  if (playbackUrl) {
    return <video src={`${playbackUrl}#t=0.8`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" />;
  }
  return <span className="thumb-fallback">{title.slice(0, 1).toUpperCase()}</span>;
}
