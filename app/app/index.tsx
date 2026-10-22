import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSettings } from "../src/features/settings/settings-context";
import { useColors } from "../src/theme/tokens";

/**
 * The app's entry gate: while settings are loading, shows a spinner;
 * once loaded, redirects to onboarding (no server/token saved yet) or
 * straight into the chat tab.
 */
export default function IndexGate() {
  const { loading, configured } = useSettings();
  const colors = useColors();

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <Redirect href={configured ? "/(tabs)/chat" : "/onboarding"} />;
}
