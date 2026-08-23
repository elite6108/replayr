import { invokeErrorMessage } from "./format";

export function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateAuthCredentials(email: string, password: string): string | null {
  const trimmed = normalizeAuthEmail(email);
  if (!trimmed || !trimmed.includes("@")) {
    return "Enter an email address to create an account or sign in.";
  }
  if (password.length < 6) {
    return "Password must be at least 6 characters.";
  }
  return null;
}

export function authErrorMessage(caught: unknown, fallback: string): string {
  const message = invokeErrorMessage(caught, fallback);
  if (/anonymous/i.test(message)) {
    return "Enter an email and password. Anonymous accounts are turned off.";
  }
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "That sign-in method is not enabled yet.";
  }
  return message || fallback;
}
