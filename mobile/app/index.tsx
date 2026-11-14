import Constants from "expo-constants";
import * as AppleAuthentication from "expo-apple-authentication";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, SafeAreaView,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import { GoogleSigninButton } from "@react-native-google-signin/google-signin";
import Purchases, { LOG_LEVEL } from "react-native-purchases";
import RevenueCatUI from "react-native-purchases-ui";
import { authorized, getAccess, revokeBackendSession } from "../lib/api";
import {
  appleSignIn, emailSignIn, exchangeFirebaseSession, firebaseSignOut,
  googleSignIn, resendVerification, resetPassword,
} from "../lib/firebase-auth";
import { disablePush, enablePush, isPushEnabled, startPushSession } from "../lib/push";
import { loadPrivacy, Privacy, reportFailure, savePrivacy, trackChatCreated, trackLogin } from "../lib/telemetry";

type User = { id: string; email: string };
type Conversation = { id: string; title: string };
type Message = { role: "user" | "assistant"; content: string };
const RC = Constants.expoConfig?.extra;
const ENTITLEMENT = RC?.revenueCatEntitlement || "pro_access";

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [legacyPassword, setLegacyPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pro, setPro] = useState(false);
  const [privacy, setPrivacy] = useState<Privacy>({ analytics: false, crash: false });
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const stopPush = useRef<(() => void) | null>(null);
  const purchasesConfigured = useRef(false);

  async function initPurchases(account: User) {
    try {
      const apiKey = Platform.OS === "ios" ? RC?.revenueCatAppleApiKey : RC?.revenueCatGoogleApiKey;
      if (!apiKey || String(apiKey).includes("REPLACE_ME")) return;
      Purchases.setLogLevel(LOG_LEVEL.WARN);
      if (!purchasesConfigured.current) {
        Purchases.configure({ apiKey, appUserID: account.id });
        purchasesConfigured.current = true;
      } else {
        await Purchases.logIn(account.id);
      }
      const info = await Purchases.getCustomerInfo();
      setPro(!!info.entitlements.active[ENTITLEMENT]);
    } catch { reportFailure("billing"); }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = await loadPrivacy();
        if (active) setPrivacy(saved);
        if (Platform.OS === "ios") {
          const available = await AppleAuthentication.isAvailableAsync();
          if (active) setAppleAvailable(available);
        }
        if (await getAccess()) {
          const result = await authorized("/api/me");
          if (!active) return;
          setUser(result.user);
          setPushOn(await isPushEnabled());
          await initPurchases(result.user);
        }
      } catch {
        if (active) Alert.alert("Session", "Could not restore your session. Sign in again or check your connection.");
      } finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!user || !pushOn || loggingOut) return;
    const stop = startPushSession();
    stopPush.current = stop;
    return () => { stop(); stopPush.current = null; };
  }, [user?.id, pushOn, loggingOut]);

  async function finishSignIn(method?: "password" | "google.com" | "apple.com") {
    const account = await exchangeFirebaseSession(legacyPassword || undefined);
    setPassword(""); setLegacyPassword("");
    setUser(account);
    setShowSettings(false); setConversation(null); setMessages([]); setPro(false);
    setPushOn(await isPushEnabled());
    await initPurchases(account);
    if (method) await trackLogin(method).catch(() => undefined);
  }
  async function authenticate(kind: "email" | "google" | "apple" | "finish") {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      if (kind === "email") {
        const signedIn = await emailSignIn(email, password, mode === "signup");
        if (!signedIn) {
          setPassword(""); setMode("login");
          Alert.alert("Verify your email", "Open the Firebase email, then press Finish verified sign-in below.");
          return;
        }
        await finishSignIn("password");
      } else if (kind === "google") {
        if (await googleSignIn()) await finishSignIn("google.com");
      } else if (kind === "apple") {
        if (await appleSignIn()) await finishSignIn("apple.com");
      } else {
        await finishSignIn();
      }
    } catch (error: any) {
      if (error?.code !== "ERR_REQUEST_CANCELED" && error?.code !== "SIGN_IN_CANCELLED") {
        reportFailure("auth");
        Alert.alert("Sign in failed", error?.message || "Please try again.");
      }
    } finally { setAuthBusy(false); }
  }
  async function changePrivacy(key: keyof Privacy, value: boolean) {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    const next = { ...privacy, [key]: value };
    try { await savePrivacy(next); setPrivacy(next); }
    catch { Alert.alert("Privacy", "Could not save this choice. Please retry."); }
    finally { setPrivacyBusy(false); }
  }
  async function togglePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushOn) {
        stopPush.current?.(); stopPush.current = null;
        await disablePush(); setPushOn(false);
      } else {
        await enablePush(); setPushOn(true);
      }
    } catch (error: any) {
      reportFailure("push"); Alert.alert("Notifications", error?.message || "Please retry.");
      if (pushOn) stopPush.current = startPushSession();
    } finally { setPushBusy(false); }
  }
  async function logout() {
    if (loggingOut || busy || authBusy || pushBusy) return;
    setLoggingOut(true);
    stopPush.current?.(); stopPush.current = null;
    try {
      await disablePush(); // Do this BEFORE clearing the server JWTs.
      setPushOn(false);
    } catch (error: any) {
      setLoggingOut(false);
      Alert.alert("Sign out paused", error?.message || "Reconnect and retry.");
      return;
    }
    try { await revokeBackendSession(); }
    catch { Alert.alert("Session", "Signed out locally. Server revocation could not be confirmed."); }
    try { await firebaseSignOut(); } catch { /* Local MOMO session is already cleared. */ }
    if (purchasesConfigured.current) {
      try { await Purchases.logOut(); } catch { /* No purchase changes requested. */ }
    }
    setUser(null); setShowSettings(false); setConversation(null); setMessages([]); setText(""); setPro(false);
    setLoggingOut(false);
  }
  async function newChat() {
    if (loggingOut) return;
    try {
      const result = await authorized("/api/conversations", { method: "POST" });
      setShowSettings(false); setConversation(result.conversation); setMessages([]);
      void trackChatCreated().catch(() => undefined);
    } catch (error: any) { reportFailure("chat"); Alert.alert("Error", error?.message); }
  }
  async function send() {
    const value = text.trim();
    if (!value || !conversation || busy || loggingOut) return;
    setText(""); setBusy(true);
    setMessages(current => [...current, { role: "user", content: value }]);
    try {
      const result = await authorized("/api/conversations/" + conversation.id + "/messages", {
        method: "POST", body: JSON.stringify({ content: value }),
      });
      setMessages(current => [...current, { role: "assistant", content: result.text }]);
    } catch (error: any) { reportFailure("chat"); Alert.alert("Message failed", error?.message); }
    finally { setBusy(false); }
  }
  async function manage() {
    if (loggingOut) return;
    try { await RevenueCatUI.presentCustomerCenter(); }
    catch { Alert.alert("Subscriptions", "Customer Center is unavailable until RevenueCat is configured."); }
  }
  const privacyControls = <View style={s.privacy}>
    <Text style={s.h2}>Privacy choices</Text>
    <Text style={s.note}>Optional, off by default. Choices apply to this installation, not just this account.</Text>
    <View style={s.row}><Text style={s.choice}>Usage analytics (Google Firebase)</Text><Switch disabled={privacyBusy} value={privacy.analytics} onValueChange={value => { void changePrivacy("analytics", value); }} /></View>
    <View style={s.row}><Text style={s.choice}>Crash reports (Google Firebase)</Text><Switch disabled={privacyBusy} value={privacy.crash} onValueChange={value => { void changePrivacy("crash", value); }} /></View>
    <Text style={s.note}>Analytics uses app interaction and device data. Crash reports include diagnostic/device data. MOMO does not add your chat text, email, or passwords to either. See our Privacy Policy for retention and deletion.</Text>
    <Pressable onPress={() => { void Linking.openURL(String(RC?.privacyPolicyUrl || "https://example.com/privacy")).catch(() => Alert.alert("Privacy", "Could not open the policy.")); }}><Text style={s.link}>Privacy Policy</Text></Pressable>
  </View>;

  if (!ready) return <SafeAreaView style={s.auth}><Text>Loading MOMO…</Text></SafeAreaView>;
  if (!user) return <SafeAreaView style={s.app}><ScrollView contentContainerStyle={s.auth} keyboardShouldPersistTaps="handled">
    <Text style={s.logo}>MOMO</Text><Text style={s.sub}>Private AI assistance.</Text>
    <TextInput style={s.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
    <TextInput style={s.input} placeholder="Firebase password (12+ characters)" secureTextEntry value={password} onChangeText={setPassword} />
    <Pressable style={s.button} disabled={authBusy} onPress={() => { void authenticate("email"); }}><Text style={s.buttonText}>{mode === "login" ? "Sign in with email" : "Create account"}</Text></Pressable>
    <Pressable disabled={authBusy} onPress={() => setMode(mode === "login" ? "signup" : "login")}><Text style={s.link}>{mode === "login" ? "Create an account" : "I already have an account"}</Text></Pressable>
    <GoogleSigninButton size={GoogleSigninButton.Size.Wide} color={GoogleSigninButton.Color.Dark} style={{ width: "100%", height: 48, marginBottom: 12 }} disabled={authBusy} onPress={() => { void authenticate("google"); }} />
    {appleAvailable && <AppleAuthentication.AppleAuthenticationButton buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN} buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK} cornerRadius={10} style={{ height: 48, marginBottom: 12 }} onPress={() => { void authenticate("apple"); }} />}
    <TextInput style={s.input} placeholder="Old MOMO password (only to link an existing account)" secureTextEntry value={legacyPassword} onChangeText={setLegacyPassword} />
    <Pressable disabled={authBusy} onPress={() => { void authenticate("finish"); }}><Text style={s.link}>Finish verified sign-in / retry linking</Text></Pressable>
    <Pressable disabled={authBusy} onPress={() => { void resendVerification().then(() => Alert.alert("Email", "Verification email sent.")).catch(error => Alert.alert("Email", error.message)); }}><Text style={s.link}>Resend verification email</Text></Pressable>
    <Pressable disabled={authBusy} onPress={() => { void resetPassword(email).then(() => Alert.alert("Email", "If this Firebase account exists, a reset email has been sent.")).catch(() => Alert.alert("Email", "Check your email address and retry.")); }}><Text style={s.link}>Reset Firebase password</Text></Pressable>
    {privacyControls}
  </ScrollView></SafeAreaView>;
  return <SafeAreaView style={s.app}>
    <View style={s.header}><Text style={s.title}>{conversation?.title || "MOMO"}</Text>
      <View style={s.row}>
        <Pressable disabled={loggingOut} onPress={manage}><Text style={s.link}>{pro ? "Manage" : "Pro"}</Text></Pressable>
        <Pressable disabled={loggingOut || busy} onPress={newChat}><Text style={s.link}>New</Text></Pressable>
        <Pressable disabled={loggingOut} onPress={() => setShowSettings(value => !value)}><Text style={s.link}>Settings</Text></Pressable>
        <Pressable disabled={loggingOut || busy || pushBusy} onPress={logout}><Text style={s.link}>Sign out</Text></Pressable>
      </View>
    </View>
    {showSettings ? <ScrollView contentContainerStyle={s.empty}>
      <Pressable style={s.button} disabled={loggingOut || pushBusy} onPress={togglePush}><Text style={s.buttonText}>{pushOn ? "Disable notifications" : "Enable notifications"}</Text></Pressable>
      {privacyControls}
      <Pressable onPress={() => setShowSettings(false)}><Text style={s.link}>Back to chat</Text></Pressable>
    </ScrollView> : !conversation ? <ScrollView contentContainerStyle={s.empty}>
      <Text style={s.h2}>Start a conversation</Text>
      <Pressable style={s.button} disabled={loggingOut} onPress={newChat}><Text style={s.buttonText}>New chat</Text></Pressable>
      <Pressable style={s.button} disabled={loggingOut || pushBusy} onPress={togglePush}><Text style={s.buttonText}>{pushOn ? "Disable notifications" : "Enable notifications"}</Text></Pressable>
      {privacyControls}
    </ScrollView> : <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList data={messages} keyExtractor={(_, i) => String(i)} contentContainerStyle={s.list} renderItem={({ item }) => <View style={[s.bubble, item.role === "user" ? s.user : s.assistant]}><Text>{item.content}</Text></View>} />
      <View style={s.composer}><TextInput style={s.chatInput} multiline value={text} onChangeText={setText} placeholder="Message…" /><Pressable style={s.send} disabled={busy || loggingOut} onPress={send}><Text style={s.buttonText}>Send</Text></Pressable></View>
    </KeyboardAvoidingView>}
  </SafeAreaView>;
}
const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#fff" }, auth: { flexGrow: 1, padding: 24, justifyContent: "center" },
  logo: { fontSize: 32, fontWeight: "700", marginBottom: 8 }, sub: { color: "#666", marginBottom: 24 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 14, marginBottom: 12 },
  button: { backgroundColor: "#111", borderRadius: 12, padding: 14, alignItems: "center", marginBottom: 12 },
  buttonText: { color: "#fff", fontWeight: "600" }, link: { color: "#2563eb", padding: 8 },
  header: { minHeight: 58, borderBottomWidth: 1, borderBottomColor: "#eee", paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 18, fontWeight: "600", flex: 1 }, row: { flexDirection: "row", alignItems: "center" },
  empty: { padding: 24, flexGrow: 1, justifyContent: "center" }, h2: { fontSize: 20, fontWeight: "600", marginBottom: 12 },
  privacy: { marginVertical: 18 }, note: { color: "#555", fontSize: 13, marginBottom: 12 }, choice: { flex: 1, paddingVertical: 12 },
  list: { padding: 18, gap: 12 }, bubble: { padding: 13, borderRadius: 16, maxWidth: "82%" },
  user: { alignSelf: "flex-end", backgroundColor: "#eee" }, assistant: { alignSelf: "flex-start", backgroundColor: "#f7f7f7" },
  composer: { flexDirection: "row", padding: 10, borderTopWidth: 1, borderTopColor: "#eee", alignItems: "flex-end" },
  chatInput: { flex: 1, maxHeight: 120, padding: 10 }, send: { backgroundColor: "#111", borderRadius: 18, paddingHorizontal: 15, paddingVertical: 10 },
});
