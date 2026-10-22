import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { radius, spacing, typography, useColors } from "../../../theme/tokens";
import type { StagedAttachment } from "../attachment-types";

export interface ComposerProps {
  placeholder: string;
  sendLabel: string;
  disabled: boolean;
  /** `attachment` is `null` for a plain text send. */
  onSend: (text: string, attachment: StagedAttachment | null) => void;

  attachment: StagedAttachment | null;
  onRemoveAttachment: () => void;
  onPickPhoto: () => void;
  onTakePhoto: () => void;
  attachPhotoLabel: string;
  takePhotoLabel: string;
  removeAttachmentLabel: string;
  photoAttachedLabel: string;
  voiceAttachedLabel: string;

  recording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  recordLabel: string;
  stopRecordingLabel: string;
  cancelRecordingLabel: string;
  recordingInProgressLabel: string;

  /**
   * Text to stage into the draft from outside the composer (the
   * Android share target, T10 work unit (b)). Bump `prefillVersion`
   * even when `prefillText` repeats the same string, so a second share
   * of identical text still re-triggers staging.
   */
  prefillText?: string;
  prefillVersion?: number;
}

/**
 * Text/attachment composer. Presentational apart from its own draft
 * text and prefill-staging state (kept local so parent re-renders
 * during streaming do not reset what the owner is typing) — attachment
 * staging itself is owned by `useAttachmentComposer` and passed in as
 * props, per the container/presentational split.
 */
export function Composer({
  placeholder,
  sendLabel,
  disabled,
  onSend,
  attachment,
  onRemoveAttachment,
  onPickPhoto,
  onTakePhoto,
  attachPhotoLabel,
  takePhotoLabel,
  removeAttachmentLabel,
  photoAttachedLabel,
  voiceAttachedLabel,
  recording,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  recordLabel,
  stopRecordingLabel,
  cancelRecordingLabel,
  recordingInProgressLabel,
  prefillText,
  prefillVersion,
}: ComposerProps) {
  const colors = useColors();
  const [draft, setDraft] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: prefillVersion is the deliberate re-trigger key, not prefillText itself (see ComposerProps doc).
  useEffect(() => {
    if (prefillText !== undefined && prefillVersion !== undefined) {
      setDraft(prefillText);
    }
  }, [prefillVersion]);

  const handleSend = () => {
    const trimmed = draft.trim();
    if (attachment) {
      onSend(trimmed, attachment);
      setDraft("");
      onRemoveAttachment();
      return;
    }
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed, null);
    setDraft("");
  };

  const canSend = !disabled && (draft.trim().length > 0 || attachment !== null) && !recording;

  return (
    <View
      style={[styles.wrapper, { borderTopColor: colors.border, backgroundColor: colors.surface }]}
    >
      {attachment ? (
        <View style={[styles.attachmentChip, { backgroundColor: colors.surfaceAlt }]}>
          {attachment.kind === "photo" ? (
            <Image source={{ uri: attachment.uri }} style={styles.attachmentThumb} />
          ) : (
            <Text style={[typography.bodySmall, { color: colors.textPrimary }]}>🎤</Text>
          )}
          <Text style={[typography.bodySmall, { color: colors.textSecondary, flex: 1 }]}>
            {attachment.kind === "photo" ? photoAttachedLabel : voiceAttachedLabel}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={removeAttachmentLabel}
            onPress={onRemoveAttachment}
            testID="composer-remove-attachment"
          >
            <Text style={{ color: colors.danger, fontWeight: "600" }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {recording ? (
        <View style={[styles.attachmentChip, { backgroundColor: colors.dangerSurface }]}>
          <Text style={[typography.bodySmall, { color: colors.danger, flex: 1 }]}>
            {recordingInProgressLabel}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelRecordingLabel}
            onPress={onCancelRecording}
            testID="composer-cancel-recording"
            style={styles.recordingButton}
          >
            <Text style={{ color: colors.textSecondary, fontWeight: "600" }}>✕</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopRecordingLabel}
            onPress={onStopRecording}
            testID="composer-stop-recording"
            style={styles.recordingButton}
          >
            <Text style={{ color: colors.danger, fontWeight: "600" }}>⏹</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.row}>
        {!recording ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={attachPhotoLabel}
              onPress={onPickPhoto}
              disabled={disabled}
              style={styles.iconButton}
              testID="composer-pick-photo"
            >
              <Text>🖼️</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={takePhotoLabel}
              onPress={onTakePhoto}
              disabled={disabled}
              style={styles.iconButton}
              testID="composer-take-photo"
            >
              <Text>📷</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={recordLabel}
              onPress={onStartRecording}
              disabled={disabled || attachment !== null}
              style={styles.iconButton}
              testID="composer-start-recording"
            >
              <Text>🎤</Text>
            </Pressable>
          </>
        ) : null}

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
          editable={!recording}
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderTopWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
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
  iconButton: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  attachmentThumb: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
  },
  recordingButton: {
    paddingHorizontal: spacing.xs,
  },
});
