export const colors = {
  bg: "#07080b",
  raised: "#141821",
  card: "#161a21",
  border: "#262c38",
  text: "#f2f4f7",
  muted: "#8b93a1",
  accent: "#7fd0ef",
  danger: "#e36b6b",
  ok: "#7dcea0",
  like: "#ff4d6d",
};

export function gameGlow(slug: string) {
  const palette = ["#EF4444", "#7fd0ef", "#22C55E", "#A855F7", "#F59E0B", "#06B6D4"];
  let hash = 0;
  for (const char of slug) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash];
}
