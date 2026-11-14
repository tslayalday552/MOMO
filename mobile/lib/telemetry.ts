import * as SecureStore from "expo-secure-store";
import { getAnalytics, logEvent, logLogin, setAnalyticsCollectionEnabled, setConsent } from "@react-native-firebase/analytics";
import { deleteUnsentReports, getCrashlytics, recordError, setCrashlyticsCollectionEnabled } from "@react-native-firebase/crashlytics";
export type Privacy = { analytics: boolean; crash: boolean };
let choice: Privacy = { analytics: false, crash: false };
async function apply() {
  await setConsent(getAnalytics(), {
    analytics_storage: choice.analytics,
    ad_storage: false, ad_user_data: false, ad_personalization: false,
  });
  await setAnalyticsCollectionEnabled(getAnalytics(), choice.analytics);
  await setCrashlyticsCollectionEnabled(getCrashlytics(), choice.crash);
  if (!choice.crash) await deleteUnsentReports(getCrashlytics());
}
export async function loadPrivacy(): Promise<Privacy> {
  const saved = await SecureStore.getItemAsync("momoPrivacyV1");
  if (saved) {
    try { const data = JSON.parse(saved); choice = { analytics: data.analytics === true, crash: data.crash === true }; }
    catch { choice = { analytics: false, crash: false }; }
  }
  await apply();
  return { ...choice };
}
export async function savePrivacy(next: Privacy) {
  if (!choice.crash && next.crash) await deleteUnsentReports(getCrashlytics());
  choice = next;
  await apply();
  await SecureStore.setItemAsync("momoPrivacyV1", JSON.stringify(choice));
}
export async function trackLogin(method: "password" | "google.com" | "apple.com") {
  if (choice.analytics) await logLogin(getAnalytics(), { method });
}
export async function trackChatCreated() {
  if (choice.analytics) await logEvent(getAnalytics(), "chat_created");
}
export function reportFailure(scope: "auth" | "chat" | "push" | "billing") {
  // Do NOT record the original exception: it may contain passwords, JWTs or prompts.
  if (choice.crash) recordError(getCrashlytics(), new Error(`MOMO ${scope} operation failed`));
}
