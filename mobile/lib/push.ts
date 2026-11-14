import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Alert, PermissionsAndroid, Platform } from "react-native";
import {
  AuthorizationStatus, deleteToken, getAPNSToken, getInitialNotification,
  getMessaging, getToken, hasPermission, onMessage, onNotificationOpenedApp,
  onTokenRefresh, registerDeviceForRemoteMessages, requestPermission, setAutoInitEnabled,
} from "@react-native-firebase/messaging";
import { authorized } from "./api";
import { reportFailure } from "./telemetry";

const messaging = getMessaging();
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}
async function installationId() {
  let value = await SecureStore.getItemAsync("momoInstallationId");
  if (!value) {
    value = Crypto.randomUUID();
    await SecureStore.setItemAsync("momoInstallationId", value);
  }
  return value;
}
export async function isPushEnabled() { return (await SecureStore.getItemAsync("momoPushEnabled")) === "true"; }
async function permissionGranted(ask: boolean) {
  if (Platform.OS === "android") {
    if (Number(Platform.Version) < 33) return true;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) return true;
    return ask && (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
  }
  const status = ask ? await requestPermission(messaging) : await hasPermission(messaging);
  return status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL;
}
async function currentToken() {
  await setAutoInitEnabled(messaging, true);
  if (Platform.OS === "ios") {
    await registerDeviceForRemoteMessages(messaging); // Auto-registration disabled in firebase.json.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await getAPNSToken(messaging)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!(await getAPNSToken(messaging))) throw new Error("APNs is not ready. Check signing and retry on a physical iPhone.");
  }
  return getToken(messaging); // FCM token, NOT the APNs token or an Expo push token.
}
async function register(token: string) {
  await authorized("/api/push/devices", {
    method: "POST",
    body: JSON.stringify({ token, installationId: await installationId(), platform: Platform.OS }),
  });
}
export async function enablePush() {
  return enqueue(async () => {
    if (!(await permissionGranted(true))) throw new Error("Notifications were not allowed. You can change this in phone Settings.");
    const token = await currentToken();
    await register(token);
    await SecureStore.setItemAsync("momoPushEnabled", "true");
  });
}
export async function disablePush() {
  generation++; // Invalidates queued callbacks from a previous signed-in user.
  return enqueue(async () => {
    let removed = false;
    let invalidated = false;
    try {
      await authorized("/api/push/devices", {
        method: "DELETE", body: JSON.stringify({ installationId: await installationId() }),
      });
      removed = true;
    } catch { /* Token invalidation below is a second way to stop delivery. */ }
    try { await setAutoInitEnabled(messaging, false); } catch { /* Still try deletion. */ }
    try { await deleteToken(messaging); invalidated = true; } catch { /* May have never registered. */ }
    if (!removed && !invalidated) throw new Error("Could not disable push. Connect to the internet and retry before signing out.");
    await SecureStore.setItemAsync("momoPushEnabled", "false");
  });
}
export function startPushSession() {
  const session = ++generation;
  let stopped = false;
  const alive = () => !stopped && session === generation;
  const sync = (rotatedToken?: string) => {
    void enqueue(async () => {
      if (!alive() || !(await isPushEnabled()) || !(await permissionGranted(false))) return;
      const token = rotatedToken || await currentToken();
      if (alive()) await register(token);
    }).catch(() => reportFailure("push"));
  };
  const unsubscribers = [
    onTokenRefresh(messaging, token => sync(token)),
    onMessage(messaging, () => {
      if (alive()) Alert.alert("MOMO", "Open MOMO for an update.");
    }),
    onNotificationOpenedApp(messaging, () => {
      // Router already opens the root screen. No untrusted URLs/deep links executed.
    }),
  ];
  void getInitialNotification(messaging).catch(() => reportFailure("push"));
  sync(); // Registers on cold start, after consent, without showing a new prompt.
  return () => { stopped = true; generation++; unsubscribers.forEach(unsubscribe => unsubscribe()); };
}
