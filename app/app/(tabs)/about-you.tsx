import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../../src/i18n/index";
import { spacing, typography, useColors } from "../../src/theme/tokens";

/**
 * Extension point for "What I know about you" (topics, memories,
 * rules — `server/src/http/me.ts`). Not implemented in T10's scope;
 * this placeholder keeps the tab route and navigation shape in place
 * for a later task to fill in.
 */
export default function AboutYouScreen() {
  const { t } = useI18n();
  const colors = useColors();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[typography.body, { color: colors.textSecondary }]}>
        {t("aboutYou.placeholder")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
});
