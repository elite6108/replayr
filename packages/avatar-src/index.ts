/** Rewrite stored Worker avatar URLs onto the client API origin (www, Vite proxy, or app URL). */
export function displayAvatarSrc(avatarUrl: string | null | undefined, apiOrigin: string): string | null {
  if (!avatarUrl) return null;
  const origin = apiOrigin.replace(/\/$/, "");
  try {
    const parsed = new URL(avatarUrl, `${origin}/`);
    if (parsed.pathname.startsWith("/v1/avatars/")) {
      return `${origin}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    /* keep stored url */
  }
  return avatarUrl;
}
