const SITE_OPEN_COOKIE = "replayr_site_open";

/** True after the site password unlocks the marketing pages. The access cookie stays HttpOnly. */
export function siteMenuOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim() === `${SITE_OPEN_COOKIE}=1`);
}
