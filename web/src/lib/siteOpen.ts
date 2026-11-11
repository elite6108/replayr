import { useEffect, useState } from "react";

const SITE_OPEN_COOKIE = "replayr_site_open";

/** True after the site password unlocks the marketing pages. The access cookie stays HttpOnly. */
export function siteMenuOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim() === `${SITE_OPEN_COOKIE}=1`);
}

/** A signed-in Replayr account opens the same site gate as the beta password. */
export async function unlockSiteForAccount(accessToken: string): Promise<void> {
  const response = await fetch("/v1/site-access/session", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error || "Could not open the site.");
}

/** Wait until a signed-in account has the site-access cookie, then leave sign-in. */
export function useUnlockedAccountSite(accessToken: string | undefined): {
  pending: boolean;
  error: string | null;
  retry: () => void;
} {
  const [token, setToken] = useState(accessToken);
  const [status, setStatus] = useState<"pending" | "ready" | "error">(accessToken ? "pending" : "ready");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  if (token !== accessToken) {
    setToken(accessToken);
    setStatus(accessToken ? "pending" : "ready");
    setError(null);
  }
  useEffect(() => {
    if (!accessToken) return;
    let cancel = false;
    unlockSiteForAccount(accessToken)
      .then(() => {
        if (!cancel) setStatus("ready");
      })
      .catch((caught) => {
        if (cancel) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Could not open the site.");
      });
    return () => {
      cancel = true;
    };
  }, [accessToken, attempt]);
  return {
    pending: status === "pending",
    error,
    retry: () => {
      setError(null);
      setStatus("pending");
      setAttempt((value) => value + 1);
    },
  };
}
