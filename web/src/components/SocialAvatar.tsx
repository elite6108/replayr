import { useEffect, useState } from "react";
import { displayAvatarSrc } from "../lib/avatarSrc";

export function SocialAvatar({
  name,
  avatarUrl,
  size = 40,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl ? displayAvatarSrc(avatarUrl, window.location.origin) : null;
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const initial = (name.trim() || "?").slice(0, 1).toUpperCase();
  return (
    <span className="social-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}
