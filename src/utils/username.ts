export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!USERNAME_PATTERN.test(trimmed)) {
    return "Usernames must be 3–24 characters: letters, numbers, or underscore.";
  }
  return null;
}
