import { useEffect, useState } from "react";
import { initials } from "../../utils/format";
import { displayAvatarSrc } from "../../utils/avatarSrc";
import { publicApiUrl } from "../../branding";

export function SocialAvatar({
  person,
  size,
}: {
  person: { displayName: string; username?: string | null; avatarUrl: string | null };
  size?: "sm" | "md" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const src = displayAvatarSrc(person.avatarUrl, publicApiUrl());
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const cls = `avatar${size === "lg" ? " lg" : size === "md" ? " md" : size === "sm" ? " sm" : ""}`;
  const label = person.displayName || person.username || "Player";
  if (src && !failed) {
    return <img className={cls} src={src} alt="" onError={() => setFailed(true)} />;
  }
  return <span className={cls}>{initials(label)}</span>;
}
