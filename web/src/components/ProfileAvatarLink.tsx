import { Link } from "react-router-dom";
import { SocialAvatar } from "./SocialAvatar";

export function ProfileAvatarLink({
  username,
  name,
  avatarUrl,
  size,
}: {
  username?: string | null;
  name: string;
  avatarUrl?: string | null;
  size?: number;
}) {
  const avatar = <SocialAvatar name={name} avatarUrl={avatarUrl} size={size} />;
  if (!username) return avatar;
  return (
    <Link
      className="profile-avatar-link"
      to={`/u/${encodeURIComponent(username)}`}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Open @${username}`}
    >
      {avatar}
    </Link>
  );
}
