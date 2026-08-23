export function isAdminUser(user?: { app_metadata?: unknown } | null, accessToken?: string | null): boolean {
  return metaRole(user?.app_metadata) === "admin" || metaRole(jwtAppMetadata(accessToken)) === "admin";
}

export function isAdminSession(session?: { access_token?: string; user?: { app_metadata?: unknown } | null } | null): boolean {
  return isAdminUser(session?.user, session?.access_token);
}

function metaRole(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as { role?: unknown }).role;
}

function jwtAppMetadata(token?: string | null): unknown {
  if (!token) return undefined;
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded)).app_metadata;
  } catch {
    return undefined;
  }
}
