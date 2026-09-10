/** Store URLs — leave empty until App Store / Play listings exist. */
export function iosAppStoreUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_IOS_APP_STORE_URL?.trim();
  return value || null;
}

export function androidPlayStoreUrl(): string | null {
  const value = process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL?.trim();
  return value || null;
}
