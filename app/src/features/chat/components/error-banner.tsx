import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface ErrorBannerProps {
  message: string;
  closeLabel: string;
  onDismiss: () => void;
}

export function ErrorBanner({ message, closeLabel, onDismiss }: ErrorBannerProps) {
  const colors = useColors();
  return (
    <View
      style={[styles.banner, { backgroundColor: colors.dangerSurface }]}
      testID="chat-error-banner"
    >
      <Text style={[typography.bodySmall, { color: colors.danger, flex: 1 }]}>{message}</Text>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={closeLabel}>
        <Text style={{ color: colors.danger, fontWeight: "600" }}>{closeLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    margin: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    gap: spacing.md,
  },
});
