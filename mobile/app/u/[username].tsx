import { useLocalSearchParams } from "expo-router";
import { UserProfileView } from "@/components/UserProfileView";

export default function UserProfileScreen() {
  const params = useLocalSearchParams<{ username: string }>();
  const username = Array.isArray(params.username) ? params.username[0] : params.username ?? "";
  return <UserProfileView username={username} />;
}
