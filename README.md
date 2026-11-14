# MOMO — Commercial SaaS + Mobile Store Starter

This package extends the chat SaaS into:
- Web backend with accounts, conversations, messages, PostgreSQL and AI integration
- Expo/React Native iOS + Android client
- EAS build configuration
- Privacy, terms, and account-deletion starter pages
- Store release checklist

It is structured for production deployment but contains placeholders that only the owner can legitimately provide: brand identity, bundle IDs, developer accounts, production domains, legal text, billing credentials, store screenshots, and store-specific subscription configuration.

See STORE_RELEASE.md before submitting.

## Firebase (sign-in, Analytics, Crashlytics, push)

The mobile app uses React Native Firebase for email, Google and Apple sign-in, opt-in Analytics and Crashlytics, and FCM push notifications. The server keeps Postgres and its own JWTs: `POST /api/auth/firebase` verifies a Firebase ID token with `firebase-admin` and returns the usual `{ user, accessToken, refreshToken }`.

Files you must add locally (they are git-ignored, never commit them):

- `mobile/google-services.json` (Firebase Android app, package `com.tmdsickazzapps.momo`)
- `mobile/GoogleService-Info.plist` (Firebase iOS app, bundle ID `com.tmdsickazzapps.momo`)
- A Firebase service-account JSON **on the server host only**, referenced by `GOOGLE_APPLICATION_CREDENTIALS` in `server/.env` (see `server/.env.example`)

Also fill `extra.googleWebClientId`, `extra.googleIosClientId`, `extra.apiUrl` and `extra.privacyPolicyUrl` in `mobile/app.json`. Firebase native modules don't run in Expo Go; use an EAS development build (`npx eas-cli build --profile development`).
