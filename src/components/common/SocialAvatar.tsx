import { initials } from "../../utils/format";

export function SocialAvatar({
  person,
  size,
}: {
  person: { displayName: string; username?: string | null; avatarUrl: string | null };
  size?: "sm" | "md" | "lg";
}) {
  const cls = `avatar${size === "lg" ? " lg" : size === "md" ? " md" : size === "sm" ? " sm" : ""}`;
  const label = person.displayName || person.username || "Player";
  if (person.avatarUrl) {
    return <img className={cls} src={person.avatarUrl} alt="" />;
  }
  return <span className={cls}>{initials(label)}</span>;
}
