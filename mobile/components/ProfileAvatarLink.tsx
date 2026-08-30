import { Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Avatar } from "@/components/Avatar";

export function ProfileAvatarLink({
  username,
  name,
  uri,
  size,
}: {
  username?: string | null;
  name?: string | null;
  uri?: string | null;
  size?: number;
}) {
  const router = useRouter();
  const avatar = <Avatar name={name} uri={uri} size={size} />;
  if (!username) return avatar;
  return (
    <Pressable
      onPress={(event) => {
        event.stopPropagation();
        router.push(`/u/${username}`);
      }}
      accessibilityRole="link"
      accessibilityLabel={`Open @${username}`}
    >
      {avatar}
    </Pressable>
  );
}
