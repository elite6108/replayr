import { Link } from "react-router-dom";
import { SocialAvatar } from "./SocialAvatar";

export function ProfileAvatarLink({
  person,
  size,
}: {
  person: { displayName: string; username?: string | null; avatarUrl: string | null };
  size?: "sm" | "md" | "lg";
}) {
  const avatar = <SocialAvatar person={person} size={size} />;
  if (!person.username) return avatar;
  return (
    <Link
      className="profile-avatar-link"
      to={`/u/${encodeURIComponent(person.username)}`}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Open @${person.username}`}
    >
      {avatar}
    </Link>
  );
}
