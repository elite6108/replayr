export const EXISTING_ACCOUNT_MESSAGE = "That email already has an account. Sign in instead.";
export const CONFIRM_EMAIL_MESSAGE = "Account created. Confirm the email, then sign in.";
export const MOBILE_EMAIL_REDIRECT = "https://www.replayr.tv/auth/mobile";

export function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Supabase hides duplicate signups behind an empty identities list when confirmation is on. */
export function signupUserAlreadyExists(user: { identities?: unknown[] | null } | null | undefined): boolean {
  return Array.isArray(user?.identities) && user.identities.length === 0;
}

export function isAlreadyRegisteredError(message: string): boolean {
  return /already registered|already been registered|user already exists/i.test(message);
}
