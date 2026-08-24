import { useEffect, useState } from "react";

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
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  const initial = (name.trim() || "?").slice(0, 1).toUpperCase();
  return (
    <span className="social-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {avatarUrl && !failed ? (
        <img src={avatarUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}
