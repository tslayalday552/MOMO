import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { getIsHeadless, getMessaging } from "@react-native-firebase/messaging";

export default function Layout() {
  const [ready, setReady] = useState(Platform.OS !== "ios");
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let mounted = true;
    void getIsHeadless(getMessaging()).then(headless => {
      if (mounted) setReady(!headless); // Do not mount screens for an iOS background push.
    }).catch(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);
  return ready ? <Stack screenOptions={{ headerShown: false }} /> : null;
}
