import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SettingsProvider } from "../src/features/settings/settings-context";
import { AppI18nProvider } from "../src/i18n/app-i18n-provider";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AppI18nProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="onboarding" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ headerShown: true, presentation: "modal" }} />
          </Stack>
        </AppI18nProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
