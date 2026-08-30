import { ClipFeedPager, firstParam } from "@/components/player/ClipFeedPager";
import { useLocalSearchParams } from "expo-router";

export default function ClipScreen() {
  const params = useLocalSearchParams<{ slug?: string | string[]; clipId?: string | string[] }>();
  const slug = firstParam(params.slug);
  const clipId = firstParam(params.clipId) || undefined;
  return <ClipFeedPager slug={slug} clipId={clipId} />;
}
