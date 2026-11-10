import { useWindowDimensions } from "react-native";

export const MAX_CONTENT_WIDTH = 720;

export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(width, MAX_CONTENT_WIDTH);
}
