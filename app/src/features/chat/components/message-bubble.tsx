import { StyleSheet, Text, View } from "react-native";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";
import type { UiMessage } from "../types";
import { CitationText } from "./citation-text";

export interface MessageBubbleProps {
  message: UiMessage;
  roleToolLabel: string;
  onCitationPress: (ref: string, sourceEntryId: string) => void;
}

/** Pure presentational rendering of one `UiMessage`. All data comes from props — no hooks, no network. */
export function MessageBubble({ message, roleToolLabel, onCitationPress }: MessageBubbleProps) {
  const colors = useColors();
  const isUser = message.role === "user";

  if (message.role === "tool") {
    return (
      <View style={[styles.toolRow]}>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{roleToolLabel}</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.bubble,
        {
          backgroundColor: isUser ? colors.accent : colors.surface,
          borderColor: colors.border,
          alignSelf: isUser ? "flex-end" : "flex-start",
        },
      ]}
      testID={`message-bubble-${message.id}`}
    >
      {message.text.length > 0 ? (
        <CitationText
          text={message.text}
          citations={message.citations}
          onCitationPress={onCitationPress}
          textStyle={[typography.body, { color: isUser ? colors.accentText : colors.textPrimary }]}
        />
      ) : (
        <Text style={[typography.body, { color: colors.textSecondary }]}>…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: "85%",
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginVertical: spacing.xs,
  },
  toolRow: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    alignSelf: "center",
  },
});
