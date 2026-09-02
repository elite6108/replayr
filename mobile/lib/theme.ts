export const colors = {
  bg: "#090b10",
  chrome: "#060a10",
  raised: "#141820",
  card: "#171d26",
  border: "#1e2530",
  chromeBorder: "rgba(255, 255, 255, 0.05)",
  text: "#f4f7fb",
  muted: "#8b93a3",
  accent: "#00d8f0",
  onAccent: "#041418",
  accentDim: "rgba(0, 216, 240, 0.14)",
  accentRing: "rgba(0, 216, 240, 0.32)",
  navActiveBg: "rgba(0, 210, 240, 0.08)",
  danger: "#e36b6b",
  ok: "#7dcea0",
  like: "#ff4d6d",
};

export const glow = {
  shadowColor: "#00d8f0",
  shadowOpacity: 0.22,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 0 },
  elevation: 6,
};

export const glowSm = {
  shadowColor: "#00d8f0",
  shadowOpacity: 0.18,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 0 },
  elevation: 3,
};

export function gameGlow(slug: string) {
  const palette = ["#EF4444", "#00d8f0", "#22C55E", "#A855F7", "#F59E0B", "#06B6D4"];
  let hash = 0;
  for (const char of slug) hash = (hash + char.charCodeAt(0)) % palette.length;
  return palette[hash];
}
