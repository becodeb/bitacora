import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ChangeGroupSummary } from "../../../api/types";
import { spacing, typography, useColors } from "../../../theme/tokens";

export interface ChangeRowProps {
  change: ChangeGroupSummary;
  undoLabel: string;
  undoneLabel: string;
  undoing: boolean;
  onUndo: () => void;
}

/** One change-group row in the "Changes" history, with its own per-row Undo. */
export function ChangeRow({ change, undoLabel, undoneLabel, undoing, onUndo }: ChangeRowProps) {
  const colors = useColors();
  return (
    <View
      style={[styles.row, { borderBottomColor: colors.border }]}
      testID={`change-row-${change.groupId}`}
    >
      <View style={styles.text}>
        <Text style={[typography.body, { color: colors.textPrimary }]}>{change.summary}</Text>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
          {new Date(change.createdAt).toLocaleString()}
        </Text>
      </View>
      {change.undone ? (
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{undoneLabel}</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={undoLabel}
          onPress={onUndo}
          disabled={undoing}
          testID={`change-undo-${change.groupId}`}
        >
          {undoing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={{ color: colors.accent, fontWeight: "600" }}>{undoLabel}</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.md,
  },
  text: {
    flex: 1,
    gap: spacing.xs,
  },
});
