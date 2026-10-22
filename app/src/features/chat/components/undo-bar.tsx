import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface UndoBarProps {
  visible: boolean;
  label: string;
  undoingLabel: string;
  undoing: boolean;
  onPress: () => void;
}

/** A small Undo affordance for the last assistant turn, per T10's no-confirmations + Undo decision. */
export function UndoBar({ visible, label, undoingLabel, undoing, onPress }: UndoBarProps) {
  const colors = useColors();
  if (!visible) {
    return null;
  }
  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Pressable
        onPress={onPress}
        disabled={undoing}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.button, { borderColor: colors.border }]}
        testID="undo-button"
      >
        {undoing ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{label}</Text>
        )}
      </Pressable>
      {undoing ? (
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{undoingLabel}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  button: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
});
