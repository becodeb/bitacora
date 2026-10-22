import { FlatList, StyleSheet, Text, View } from "react-native";
import { spacing, typography, useColors } from "../../../theme/tokens";
import type { UiMessage } from "../types";
import { MessageBubble } from "./message-bubble";

export interface MessageListProps {
  messages: UiMessage[];
  roleToolLabel: string;
  emptyLabel: string;
  onCitationPress: (ref: string, sourceEntryId: string) => void;
}

export function MessageList({
  messages,
  roleToolLabel,
  emptyLabel,
  onCitationPress,
}: MessageListProps) {
  const colors = useColors();

  if (messages.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={messages}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => (
        <MessageBubble
          message={item}
          roleToolLabel={roleToolLabel}
          onCitationPress={onCitationPress}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
});
