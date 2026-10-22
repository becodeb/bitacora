import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MemorySummary, TopicOverview } from "../../../api/types";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface MemoryRowProps {
  memory: MemorySummary;
  /** Every other topic, for the "move to" picker — excludes the memory's own current topic. */
  otherTopics: TopicOverview[];
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  moveLabel: string;
  moveToNoTopicLabel: string;
  deleteLabel: string;
  citationLabel: string;
  onSaveContent: (content: string) => void;
  onMove: (topicId: string | null) => void;
  onDelete: () => void;
  onOpenCitation: () => void;
}

/**
 * One memory row: its text, a tappable source citation (reuses the
 * chat's citation sheet via `onOpenCitation`), and the owner's three
 * correction actions (edit / move / delete) — every one applies
 * immediately once confirmed here, no extra dialog, per
 * `odd/tasks/mvp.md`'s "No confirmations" decision.
 */
export function MemoryRow({
  memory,
  otherTopics,
  editLabel,
  saveLabel,
  cancelLabel,
  moveLabel,
  moveToNoTopicLabel,
  deleteLabel,
  citationLabel,
  onSaveContent,
  onMove,
  onDelete,
  onOpenCitation,
}: MemoryRowProps) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [movePickerOpen, setMovePickerOpen] = useState(false);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== memory.content) {
      onSaveContent(trimmed);
    }
    setEditing(false);
  };

  return (
    <View
      style={[styles.row, { borderBottomColor: colors.border }]}
      testID={`memory-row-${memory.id}`}
    >
      {editing ? (
        <View style={styles.editBlock}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            style={[
              typography.body,
              styles.input,
              { color: colors.textPrimary, backgroundColor: colors.surfaceAlt },
            ]}
            testID={`memory-edit-input-${memory.id}`}
          />
          <View style={styles.actionsRow}>
            <Pressable onPress={handleSave} testID={`memory-save-${memory.id}`}>
              <Text style={{ color: colors.accent, fontWeight: "600" }}>{saveLabel}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraft(memory.content);
                setEditing(false);
              }}
            >
              <Text style={{ color: colors.textSecondary }}>{cancelLabel}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setEditing(true)} testID={`memory-content-${memory.id}`}>
          <Text style={[typography.body, { color: colors.textPrimary }]}>{memory.content}</Text>
        </Pressable>
      )}

      <View style={styles.actionsRow}>
        <Pressable onPress={onOpenCitation} testID={`memory-citation-${memory.id}`}>
          <Text style={[typography.bodySmall, { color: colors.accent }]}>{citationLabel}</Text>
        </Pressable>
        {!editing ? (
          <Pressable onPress={() => setEditing(true)}>
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{editLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setMovePickerOpen((v) => !v)}
          testID={`memory-move-toggle-${memory.id}`}
        >
          <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{moveLabel}</Text>
        </Pressable>
        <Pressable onPress={onDelete} testID={`memory-delete-${memory.id}`}>
          <Text style={[typography.bodySmall, { color: colors.danger }]}>{deleteLabel}</Text>
        </Pressable>
      </View>

      {movePickerOpen ? (
        <View style={[styles.movePicker, { backgroundColor: colors.surfaceAlt }]}>
          <Pressable
            onPress={() => {
              onMove(null);
              setMovePickerOpen(false);
            }}
            testID={`memory-move-to-none-${memory.id}`}
          >
            <Text
              style={[typography.bodySmall, { color: colors.textPrimary, padding: spacing.xs }]}
            >
              {moveToNoTopicLabel}
            </Text>
          </Pressable>
          {otherTopics.map((topic) => (
            <Pressable
              key={topic.id}
              onPress={() => {
                onMove(topic.id);
                setMovePickerOpen(false);
              }}
              testID={`memory-move-to-${topic.id}`}
            >
              <Text
                style={[typography.bodySmall, { color: colors.textPrimary, padding: spacing.xs }]}
              >
                {topic.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  editBlock: {
    gap: spacing.sm,
  },
  input: {
    borderRadius: radius.md,
    padding: spacing.sm,
    minHeight: 44,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.lg,
  },
  movePicker: {
    borderRadius: radius.md,
    padding: spacing.xs,
  },
});
