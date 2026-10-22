import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { CitationSheet } from "../../src/features/chat/components/citation-sheet";
import { Composer } from "../../src/features/chat/components/composer";
import { ErrorBanner } from "../../src/features/chat/components/error-banner";
import { MessageList } from "../../src/features/chat/components/message-list";
import { ToolActivityIndicator } from "../../src/features/chat/components/tool-activity-indicator";
import { UndoBar } from "../../src/features/chat/components/undo-bar";
import { useAttachmentComposer } from "../../src/features/chat/use-attachment-composer";
import { useChatContainer } from "../../src/features/chat/use-chat";
import { useCitationEntry } from "../../src/features/chat/use-citation-entry";
import { useShareIntentStaging } from "../../src/features/chat/use-share-intent-staging";
import { useSettings } from "../../src/features/settings/settings-context";
import { useI18n } from "../../src/i18n/index";
import { useColors } from "../../src/theme/tokens";

const ATTACHMENT_ERROR_KEYS = {
  unsupportedMime: "chat.attachmentErrorUnsupportedMime",
  tooLarge: "chat.attachmentErrorTooLarge",
  permissionDenied: "chat.attachmentErrorPermissionDenied",
} as const;

/**
 * The chat screen (route). All data/streaming logic lives in
 * `useChatContainer` (text/attachment turns) and
 * `useAttachmentComposer` (photo/voice staging); this component only
 * wires their state to presentational pieces, per the
 * container/presentational split.
 */
export default function ChatScreen() {
  const { t } = useI18n();
  const colors = useColors();
  const { client } = useSettings();
  const chat = useChatContainer(client);
  const citationEntry = useCitationEntry(client);
  const attachmentComposer = useAttachmentComposer();
  const shareIntentStaging = useShareIntentStaging(attachmentComposer);

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
      ) : attachmentComposer.error ? (
        <ErrorBanner
          message={t(ATTACHMENT_ERROR_KEYS[attachmentComposer.error])}
          closeLabel={t("common.close")}
          onDismiss={attachmentComposer.dismissError}
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
        onSend={(text, attachment) => {
          if (attachment) {
            void chat.sendAttachment(attachment, text);
          } else {
            void chat.sendText(text);
          }
        }}
        attachment={attachmentComposer.attachment}
        onRemoveAttachment={attachmentComposer.clearAttachment}
        onPickPhoto={attachmentComposer.pickFromGallery}
        onTakePhoto={attachmentComposer.takePhoto}
        attachPhotoLabel={t("chat.attachPhoto")}
        takePhotoLabel={t("chat.takePhoto")}
        removeAttachmentLabel={t("chat.removeAttachment")}
        photoAttachedLabel={t("chat.photoAttached")}
        voiceAttachedLabel={t("chat.voiceAttached")}
        recording={attachmentComposer.recording}
        onStartRecording={attachmentComposer.startRecording}
        onStopRecording={attachmentComposer.stopRecording}
        onCancelRecording={attachmentComposer.cancelRecording}
        recordLabel={t("chat.record")}
        stopRecordingLabel={t("chat.stopRecording")}
        cancelRecordingLabel={t("chat.cancelRecording")}
        recordingInProgressLabel={t("chat.recordingInProgress", {
          seconds: Math.floor(attachmentComposer.recordingMillis / 1000),
        })}
        prefillText={shareIntentStaging.prefillText}
        prefillVersion={shareIntentStaging.prefillVersion}
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
