# Replayr mobile

Expo app for the same cloud product as `web/`: sign in, library, play, share, Games, account. Capture stays on Windows.

```bash
cd mobile
copy .env.example .env
# Fill EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_APP_URL
npx expo start
```

Use `EXPO_PUBLIC_APP_URL=https://www.replayr.tv` when running on a phone. `127.0.0.1` is the phone itself.

## Auth redirects

Add these to Supabase Auth → URL configuration:

- `tv.elite.replay://auth/callback`
- `https://www.replayr.tv/auth/callback` (already used by the website)

Enable **Sign in with Apple** in Supabase Auth before shipping iOS. Apple requires it if Google / Discord / X are offered.

## EAS builds

This repo is edited on Windows. iOS binaries are built with EAS, not a local Simulator.

```bash
npm i -g eas-cli
eas login
eas init
eas secret:create --name EXPO_PUBLIC_SUPABASE_URL --value https://YOUR_PROJECT.supabase.co
eas secret:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value YOUR_ANON_KEY
eas build --platform android --profile preview
eas build --platform ios --profile production
```

Never put `SUPABASE_SERVICE_ROLE_KEY` or R2 keys in `EXPO_PUBLIC_*` or EAS secrets for the app.

## Store kit

- Display name: Replayr
- Bundle id / package: `tv.elite.replay` (use `tv.elite.replay.mobile` if the desktop name is reserved)
- Privacy: https://www.replayr.tv/privacy
- Terms: https://www.replayr.tv/terms
- Support: the same address as the website
- Universal Links need a hosted `apple-app-site-association` with your Apple Team ID. The custom scheme `tv.elite.replay://` works without it.
- Delete account is `POST /v1/account/delete` (Worker, service-role). The in-app Account screen exposes it.
- App Store privacy: video clips the user uploads from Windows; account email; no tracking SDK. Nutrition labels are filled in App Store Connect.
- Play Data safety: same. Account deletion is required.

Subtitle: Watch and share Replayr clips.

Description:
Replayr on your phone is the same cloud library as replayr.tv. Sign in with the account you already use on Windows, watch uploads, change visibility, and send an unlisted link that never includes your username. Capture and Instant Replay stay on the PC.

You submit TestFlight and Play internal testing from App Store Connect / Play Console.
