import { Stack } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SettingsProvider } from "../src/features/settings/settings-context";
import { AppI18nProvider } from "../src/i18n/app-i18n-provider";

export default function RootLayout() {
  return (
    // `ShareIntentProvider` must wrap everything else — per
    // `expo-share-intent`'s own docs, it has to sit above any other
    // provider so its native-module hook mounts before the rest of the
    // tree. See `+native-intent.ts` for the redirect that routes a
    // cold- or warm-started share to the chat tab, and
    // `src/features/chat/use-share-intent-staging.ts` for how that
    // screen consumes it (Android share target, T10 work unit (b)).
    <ShareIntentProvider options={{ resetOnBackground: true }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <AppI18nProvider>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="onboarding" options={{ headerShown: false }} />
              <Stack.Screen
                name="settings"
                options={{ headerShown: true, presentation: "modal" }}
              />
            </Stack>
          </AppI18nProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
