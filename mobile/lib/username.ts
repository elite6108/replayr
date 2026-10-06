export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;

export function validateUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!USERNAME_PATTERN.test(trimmed)) {
    return "Usernames must be 3–24 characters: letters, numbers, or underscore.";
  }
  return null;
}

export function usernameTakenMessage(error: { message: string; code?: string }): string {
  if (error.code === "23505" || /duplicate|unique/i.test(error.message)) {
    return "That username is taken.";
  }
  return error.message;
}
