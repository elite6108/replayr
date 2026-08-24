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

This repo is edited on Windows. iOS binaries are built with EAS, not a local Simulator. The Expo project is `@elite6108/replayr` (`tv.elite.replay`). Production env vars live on EAS (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_APP_URL`). Do not put `SUPABASE_SERVICE_ROLE_KEY` or R2 keys in `EXPO_PUBLIC_*` or EAS env.

```bash
cd mobile
npx eas-cli login
# or: export EXPO_TOKEN=...   (expo.dev → Access tokens)
npx eas-cli env:list production
```

Android internal APK:

```bash
npx eas-cli build --platform android --profile preview --non-interactive
```

## Publish to TestFlight

App Store Connect app id is `6804367755`. The `production` iOS profile auto-increments `buildNumber` on EAS (`appVersionSource: remote`). Apple credentials and the App Store Connect API key are already stored on EAS.

From `mobile/`:

```bash
npx eas-cli login
npx eas-cli build --platform ios --profile production --auto-submit --non-interactive
```

That queues an iOS production build and submits the IPA to TestFlight when it finishes. Do **not** pass `--what-to-test`; that TestFlight changelog field is Expo Enterprise only and the submit will fail.

If the build finishes without a submit (or auto-submit fails), submit the finished build id yourself:

```bash
npx eas-cli build:list --platform ios --limit 3
npx eas-cli submit --platform ios --profile production --id <BUILD_ID> --non-interactive --wait
```

Watch status:

```bash
npx eas-cli build:view <BUILD_ID>
npx eas-cli submit:status
```

When `submit:status` shows `1.0.0 (N) — internal: in beta testing`, internal testers can install it from the TestFlight app. Apple may still process the binary for a few minutes after EAS reports finished.

- Builds: https://expo.dev/accounts/elite6108/projects/replayr/builds
- Submissions: https://expo.dev/accounts/elite6108/projects/replayr/submissions
- App Store Connect: https://appstoreconnect.apple.com/apps/6804367755

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

Play internal testing is submitted from Play Console. TestFlight is submitted with EAS (`eas submit` / `--auto-submit`) as above.
