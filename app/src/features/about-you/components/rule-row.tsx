import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { RuleSummary } from "../../../api/types";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface RuleRowProps {
  rule: RuleSummary;
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  deleteLabel: string;
  invalidJsonLabel: string;
  /** `payload` is already-parsed JSON (`JSON.parse` of the edited text succeeded). */
  onSavePayload: (payload: unknown) => void;
  onDelete: () => void;
}

/**
 * One rule row. A rule's `payload` is free-form JSON (`server/src/http/me.ts`'s
 * `putRuleBodySchema` accepts `z.unknown()`), so editing it is a raw
 * JSON textarea with a parse check before saving — there is no
 * generic rule schema to build a structured form from.
 */
export function RuleRow({
  rule,
  editLabel,
  saveLabel,
  cancelLabel,
  deleteLabel,
  invalidJsonLabel,
  onSavePayload,
  onDelete,
}: RuleRowProps) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(rule.payload, null, 2));
  const [invalid, setInvalid] = useState(false);

  const handleSave = () => {
    try {
      const parsed = JSON.parse(draft);
      setInvalid(false);
      onSavePayload(parsed);
      setEditing(false);
    } catch {
      setInvalid(true);
    }
  };

  return (
    <View
      style={[styles.row, { borderBottomColor: colors.border }]}
      testID={`rule-row-${rule.key}`}
    >
      <Text style={[typography.body, { color: colors.textPrimary }]}>{rule.key}</Text>
      {rule.topicName ? (
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
          {rule.topicName}
        </Text>
      ) : null}

      {editing ? (
        <View style={styles.editBlock}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            style={[
              typography.bodySmall,
              styles.input,
              { color: colors.textPrimary, backgroundColor: colors.surfaceAlt },
            ]}
            testID={`rule-edit-input-${rule.key}`}
          />
          {invalid ? <Text style={{ color: colors.danger }}>{invalidJsonLabel}</Text> : null}
          <View style={styles.actionsRow}>
            <Pressable onPress={handleSave} testID={`rule-save-${rule.key}`}>
              <Text style={{ color: colors.accent, fontWeight: "600" }}>{saveLabel}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraft(JSON.stringify(rule.payload, null, 2));
                setInvalid(false);
                setEditing(false);
              }}
            >
              <Text style={{ color: colors.textSecondary }}>{cancelLabel}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={2}>
          {JSON.stringify(rule.payload)}
        </Text>
      )}

      <View style={styles.actionsRow}>
        {!editing ? (
          <Pressable onPress={() => setEditing(true)} testID={`rule-edit-toggle-${rule.key}`}>
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{editLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onDelete} testID={`rule-delete-${rule.key}`}>
          <Text style={[typography.bodySmall, { color: colors.danger }]}>{deleteLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.xs,
  },
  editBlock: {
    gap: spacing.sm,
  },
  input: {
    borderRadius: radius.md,
    padding: spacing.sm,
    minHeight: 60,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.lg,
  },
});
