/** True only when the provider window returned a completed sign-in. */
export function providerPromptCompleted(resultType: string): boolean {
  return resultType === "success";
}

/** A dismissed or closed provider window must not continue into account deletion. */
export function assertProviderPromptCompleted(resultType: string): void {
  if (!providerPromptCompleted(resultType)) {
    throw new Error("Sign in with your provider again, then delete the account.");
  }
}
