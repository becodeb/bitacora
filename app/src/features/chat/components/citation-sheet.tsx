import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { EntryView } from "../../../api/types";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";

export interface CitationSheetProps {
  visible: boolean;
  loading: boolean;
  entry: EntryView | null;
  error: string | null;
  title: string;
  closeLabel: string;
  onClose: () => void;
}

/** Modal showing a cited source entry's text, opened by tapping a `[#n]` chip (`CitationText`). Purely presentational: `useCitationEntry` owns the fetch. */
export function CitationSheet({
  visible,
  loading,
  entry,
  error,
  title,
  closeLabel,
  onClose,
}: CitationSheetProps) {
  const colors = useColors();
  const text = entry?.derivedText ?? entry?.textBody ?? "";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.surface }]} testID="citation-sheet">
          <View style={styles.header}>
            <Text style={[typography.title, { color: colors.textPrimary }]}>{title}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={closeLabel}>
              <Text style={{ color: colors.accent, fontWeight: "600" }}>{closeLabel}</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body}>
            {loading ? (
              <ActivityIndicator color={colors.accent} />
            ) : error ? (
              <Text style={{ color: colors.danger }}>{error}</Text>
            ) : (
              <Text style={[typography.body, { color: colors.textPrimary }]}>
                {text.length > 0 ? text : "—"}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: "70%",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  body: {
    marginBottom: spacing.md,
  },
});
