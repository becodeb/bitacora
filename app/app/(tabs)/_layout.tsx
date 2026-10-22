import { Link, Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { useI18n } from "../../src/i18n/index";
import { useColors } from "../../src/theme/tokens";

export default function TabsLayout() {
  const { t } = useI18n();
  const colors = useColors();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textPrimary,
        headerRight: () => (
          <Link href="/settings" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel={t("settings.title")}>
              <Text style={{ color: colors.accent, marginRight: 16 }}>{"⚙"}</Text>
            </Pressable>
          </Link>
        ),
      }}
    >
      <Tabs.Screen name="chat" options={{ title: t("chat.title") }} />
      <Tabs.Screen name="about-you" options={{ title: t("aboutYou.title") }} />
    </Tabs>
  );
}
