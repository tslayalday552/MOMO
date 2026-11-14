import Constants from "expo-constants";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";
import {
  AppleAuthProvider, GoogleAuthProvider, createUserWithEmailAndPassword,
  getAuth, getIdToken, reload, sendEmailVerification, sendPasswordResetEmail,
  signInWithCredential, signInWithEmailAndPassword, signOut,
} from "@react-native-firebase/auth";
import { Platform } from "react-native";
import { api, setSession } from "./api";

// Native Firebase initialization comes from the json/plist. No initializeApp JS config.
const auth = getAuth();
GoogleSignin.configure({
  webClientId: String(Constants.expoConfig?.extra?.googleWebClientId || ""),
  iosClientId: String(Constants.expoConfig?.extra?.googleIosClientId || ""),
});
export async function emailSignIn(email: string, password: string, signup: boolean) {
  const normalized = email.trim().toLowerCase();
  if (signup) {
    if (password.length < 12) throw new Error("Use a password of at least 12 characters.");
    const result = await createUserWithEmailAndPassword(auth, normalized, password);
    await sendEmailVerification(result.user);
    return false; // Must verify email before receiving a MOMO session.
  }
  await signInWithEmailAndPassword(auth, normalized, password);
  return true;
}
export async function googleSignIn() {
  if (Platform.OS === "android") await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (!isSuccessResponse(result)) return false; // Cancel is not an error.
  if (!result.data.idToken) throw new Error("Google did not return an ID token.");
  await signInWithCredential(auth, GoogleAuthProvider.credential(result.data.idToken));
  return true;
}
export async function appleSignIn() {
  if (Platform.OS !== "ios" || !(await AppleAuthentication.isAvailableAsync())) {
    throw new Error("Apple sign-in is unavailable on this device.");
  }
  const rawNonce = Array.from(Crypto.getRandomBytes(32), b => b.toString(16).padStart(2, "0")).join("");
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
  const result = await AppleAuthentication.signInAsync({
    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
    nonce: hashedNonce,
  });
  if (!result.identityToken) throw new Error("Apple did not return an identity token.");
  await signInWithCredential(auth, AppleAuthProvider.credential(result.identityToken, rawNonce));
  return true;
}
export async function exchangeFirebaseSession(legacyPassword?: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to Firebase first.");
  await reload(user);
  if (!user.emailVerified) throw new Error("Open your verification email, then press Finish verified sign-in.");
  const idToken = await getIdToken(user, true);
  const result = await api("/api/auth/firebase", {
    method: "POST",
    body: JSON.stringify({ idToken, ...(legacyPassword ? { legacyPassword } : {}) }),
  });
  await setSession(result.accessToken, result.refreshToken);
  return result.user as { id: string; email: string };
}
export async function resendVerification() {
  if (!auth.currentUser) throw new Error("Create an account or sign in first.");
  await sendEmailVerification(auth.currentUser);
}
export async function resetPassword(email: string) { await sendPasswordResetEmail(auth, email.trim().toLowerCase()); }
export async function firebaseSignOut() {
  await signOut(auth);
  try { await GoogleSignin.signOut(); } catch { /* May not have used Google. */ }
}
