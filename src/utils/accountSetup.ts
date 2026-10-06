const KEY = "replay.pendingAccount";
export const ACCOUNT_SETUP_EVENT = "replay-account-setup";

export function accountSetupPending(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markAccountSetupPending(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* private mode */
  }
}

export function clearAccountSetupPending(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(ACCOUNT_SETUP_EVENT));
}
