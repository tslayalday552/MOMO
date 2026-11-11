# Store release checklist

## Required before submission
1. Replace the placeholder app name, company name, bundle/package ID, support email, privacy URL, terms URL, and account-deletion URL.
2. Deploy the API on HTTPS and set `CORS_ORIGIN` appropriately.
3. Use a managed PostgreSQL database with backups.
4. Add a native mobile auth token response. The current web backend uses an HttpOnly cookie; native clients should receive a short-lived access token plus a refresh-token/session mechanism stored in platform secure storage. Do not store JWTs in plain AsyncStorage for the final build.
5. Implement Apple/Google in-app purchases for paid subscriptions. The server must validate purchase receipts/tokens and maintain entitlements. Do not use Stripe checkout for digital subscriptions inside the iOS/Android app.
6. Add subscription restoration and cancellation links.
7. Add email verification and password reset.
8. Add self-service account deletion.
9. Add abuse/content safety controls, usage quotas, and monitoring.
10. Replace legal templates with counsel-approved policies.

## Android
Google Play requires new apps and updates submitted from August 31, 2026 to target Android 16/API 36 or higher. Build an Android App Bundle (`.aab`) and use Play App Signing.

Typical commands:
`npm install`
`npm install -g eas-cli`
`eas login`
`eas build --platform android --profile production`
`eas submit --platform android`

## iOS
Create the App Store Connect app with the bundle identifier, then:
`eas build --platform ios --profile production`
`eas submit --platform ios`

EAS uploads the iOS build to App Store Connect/TestFlight; App Store review and production release still require App Store Connect actions.

## Store metadata
Prepare:
- App icon
- Android adaptive icon
- iPhone/iPad screenshots
- Android phone/tablet screenshots as applicable
- App description and short description
- Support URL
- Privacy policy URL
- Terms URL
- Account deletion URL
- Age/content rating
- Data safety/privacy disclosures
- Subscription product names, prices, descriptions, and screenshots where required
- Review/demo account if requested by the store

## Important
A generated project cannot itself create your Apple/Google developer accounts, accept legal agreements, provide tax/banking information, or submit on your behalf. Those require your account credentials and human acceptance.
