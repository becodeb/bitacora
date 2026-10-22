import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TopicOverview } from "../../../api/types";
import { spacing, typography, useColors } from "../../../theme/tokens";

export interface TopicRowProps {
  topic: TopicOverview;
  memoryCountLabel: string;
  onPress: () => void;
}

/** One row in the topics list — presentational only, no own state. */
export function TopicRow({ topic, memoryCountLabel, onPress }: TopicRowProps) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, { borderBottomColor: colors.border }]}
      testID={`topic-row-${topic.id}`}
    >
      <View style={styles.text}>
        <Text style={[typography.body, { color: colors.textPrimary }]}>{topic.name}</Text>
        {topic.summary ? (
          <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>
            {topic.summary}
          </Text>
        ) : null}
      </View>
      <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
        {memoryCountLabel}
      </Text>
    </Pressable>
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
    gap: spacing.sm,
  },
  text: {
    flex: 1,
    gap: spacing.xs,
  },
});
