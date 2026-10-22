import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { CitationSheet } from "../../src/features/chat/components/citation-sheet";
import { Composer } from "../../src/features/chat/components/composer";
import { ErrorBanner } from "../../src/features/chat/components/error-banner";
import { MessageList } from "../../src/features/chat/components/message-list";
import { ToolActivityIndicator } from "../../src/features/chat/components/tool-activity-indicator";
import { UndoBar } from "../../src/features/chat/components/undo-bar";
import { useChatContainer } from "../../src/features/chat/use-chat";
import { useCitationEntry } from "../../src/features/chat/use-citation-entry";
import { useSettings } from "../../src/features/settings/settings-context";
import { useI18n } from "../../src/i18n/index";
import { useColors } from "../../src/theme/tokens";

/**
 * The chat screen (route). All data/streaming logic lives in
 * `useChatContainer`; this component only wires its state to
 * presentational pieces, per the container/presentational split.
 */
export default function ChatScreen() {
  const { t } = useI18n();
  const colors = useColors();
  const { client } = useSettings();
  const chat = useChatContainer(client);
  const citationEntry = useCitationEntry(client);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {chat.error ? (
        <ErrorBanner
          message={chat.error === "network" ? t("chat.errorNetwork") : t("chat.errorGeneric")}
          closeLabel={t("common.close")}
          onDismiss={chat.dismissError}
        />
      ) : null}

      <View style={styles.listArea}>
        <MessageList
          messages={chat.messages}
          roleToolLabel={t("chat.roleTool")}
          emptyLabel={t("chat.emptyHistory")}
          onCitationPress={(_ref, sourceEntryId) => citationEntry.openCitation(sourceEntryId)}
        />
      </View>

      <ToolActivityIndicator statusSummary={chat.toolStatus} />

      <UndoBar
        visible={chat.canUndo && !chat.sending}
        label={t("chat.undo")}
        undoingLabel={t("chat.undoing")}
        undoing={chat.undoing}
        onPress={chat.undoLast}
      />

      <Composer
        placeholder={t("chat.composerPlaceholder")}
        sendLabel={t("chat.send")}
        disabled={chat.sending}
        onSend={chat.sendText}
      />

      <CitationSheet
        visible={citationEntry.open}
        loading={citationEntry.loading}
        entry={citationEntry.entry}
        error={citationEntry.error}
        title={t("chat.citationsSheetTitle")}
        closeLabel={t("common.close")}
        onClose={citationEntry.close}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listArea: {
    flex: 1,
  },
});
