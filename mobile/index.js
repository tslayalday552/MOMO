import { getMessaging, setBackgroundMessageHandler } from "@react-native-firebase/messaging";

// Must be registered outside React and before Expo Router starts.
setBackgroundMessageHandler(getMessaging(), async () => {
  // No UI, tokens, prompts, or message content in logs/analytics here.
  // Notification payloads are displayed by the OS when the app is backgrounded.
});
require("expo-router/entry");
