import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TopicOverview } from "../../../api/types";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface TopicHeaderProps {
  topic: TopicOverview;
  backLabel: string;
  renameLabel: string;
  saveLabel: string;
  cancelLabel: string;
  onBack: () => void;
  onRename: (name: string) => void;
}

/** Topic-detail header: back button and an inline rename, per T10 work unit (c). */
export function TopicHeader({
  topic,
  backLabel,
  renameLabel,
  saveLabel,
  cancelLabel,
  onBack,
  onRename,
}: TopicHeaderProps) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(topic.name);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== topic.name) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  return (
    <View style={[styles.container, { borderBottomColor: colors.border }]}>
      <Pressable onPress={onBack} testID="topic-header-back">
        <Text style={{ color: colors.accent }}>{backLabel}</Text>
      </Pressable>

      {editing ? (
        <View style={styles.editRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            style={[
              typography.title,
              styles.input,
              { color: colors.textPrimary, backgroundColor: colors.surfaceAlt },
            ]}
            testID="topic-header-input"
          />
          <Pressable onPress={handleSave} testID="topic-header-save">
            <Text style={{ color: colors.accent, fontWeight: "600" }}>{saveLabel}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setDraft(topic.name);
              setEditing(false);
            }}
          >
            <Text style={{ color: colors.textSecondary }}>{cancelLabel}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          style={styles.editRow}
          onPress={() => setEditing(true)}
          testID="topic-header-rename-toggle"
        >
          <Text style={[typography.title, { color: colors.textPrimary }]}>{topic.name}</Text>
          <Text style={[typography.bodySmall, { color: colors.accent }]}>{renameLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  editRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
