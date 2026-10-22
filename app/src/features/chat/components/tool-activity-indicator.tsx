import { StyleSheet, Text, View } from "react-native";
import { spacing, typography, useColors } from "../../../theme/tokens";

export interface ToolActivityIndicatorProps {
  statusSummary: string | null;
}

/** A subtle one-line indicator for the most recent `tool` SSE event, per T10's "subtle tool-activity indicator" requirement. Renders nothing when there is no active status. */
export function ToolActivityIndicator({ statusSummary }: ToolActivityIndicatorProps) {
  const colors = useColors();
  if (!statusSummary) {
    return null;
  }
  return (
    <View style={styles.row} testID="tool-activity-indicator">
      <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{statusSummary}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
});
