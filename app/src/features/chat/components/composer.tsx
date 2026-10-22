import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface ComposerProps {
  placeholder: string;
  sendLabel: string;
  disabled: boolean;
  onSend: (text: string) => void;
}

/**
 * Text composer, presentational apart from its own draft-text state
 * (kept local so parent re-renders during streaming do not reset the
 * input the owner is typing). Attachment/voice input are intentional
 * extension points, not implemented here — see T10's scope note.
 */
export function Composer({ placeholder, sendLabel, disabled, onSend }: ComposerProps) {
  const colors = useColors();
  const [draft, setDraft] = useState("");

  const handleSend = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed);
    setDraft("");
  };

  const canSend = !disabled && draft.trim().length > 0;

  return (
    <View style={[styles.row, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={[
          styles.input,
          typography.body,
          { color: colors.textPrimary, backgroundColor: colors.surfaceAlt },
        ]}
        multiline
        testID="composer-input"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sendLabel}
        onPress={handleSend}
        disabled={!canSend}
        style={[styles.sendButton, { backgroundColor: canSend ? colors.accent : colors.border }]}
        testID="composer-send"
      >
        <Text style={{ color: colors.accentText, fontWeight: "600" }}>{sendLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
  },
  sendButton: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
