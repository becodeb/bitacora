import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from "expo-image-picker";
import { useCallback, useState } from "react";
import type { StagedAttachment } from "./attachment-types";
import { validateAttachment } from "./attachment-types";

export interface AttachmentComposerState {
  attachment: StagedAttachment | null;
  error: "unsupportedMime" | "tooLarge" | "permissionDenied" | null;
  recording: boolean;
  recordingMillis: number;
}

export interface AttachmentComposerContainer extends AttachmentComposerState {
  pickFromGallery: () => Promise<void>;
  takePhoto: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  clearAttachment: () => void;
  /** Stages a file handed in from outside the composer's own pickers — the Android share target (T10 work unit (b)). */
  stageSharedPhoto: (uri: string, mimeType: string, fileName: string) => void;
  dismissError: () => void;
}

/**
 * Owns photo/voice attachment staging for the chat composer: picking a
 * photo (camera or gallery, `expo-image-picker`), recording a voice
 * note (`expo-audio`, `.m4a`/AAC per `odd/tasks/mvp.md`), and staging a
 * file shared in from another app. `Composer` itself stays
 * presentational — this hook is the container half, used by the chat
 * screen alongside `useChatContainer`.
 */
export function useAttachmentComposer(): AttachmentComposerContainer {
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [error, setError] = useState<AttachmentComposerState["error"]>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);

  const dismissError = useCallback(() => setError(null), []);

  const stageIfValid = useCallback(
    (
      kind: "photo" | "voice",
      uri: string,
      mimeType: string,
      fileName: string,
      sizeBytes?: number,
    ) => {
      const validation = validateAttachment(mimeType, sizeBytes);
      if (!validation.ok) {
        setError(validation.errorKey ?? "unsupportedMime");
        return;
      }
      setError(null);
      setAttachment({ kind, uri, mimeType, fileName });
    },
    [],
  );

  const pickFromGallery = useCallback(async () => {
    const permission = await requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("permissionDenied");
      return;
    }
    const result = await launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || result.assets.length === 0) {
      return;
    }
    const asset = result.assets[0];
    stageIfValid(
      "photo",
      asset.uri,
      asset.mimeType ?? "image/jpeg",
      asset.fileName ?? `photo-${Date.now()}.jpg`,
      asset.fileSize,
    );
  }, [stageIfValid]);

  const takePhoto = useCallback(async () => {
    const permission = await requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError("permissionDenied");
      return;
    }
    const result = await launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || result.assets.length === 0) {
      return;
    }
    const asset = result.assets[0];
    stageIfValid(
      "photo",
      asset.uri,
      asset.mimeType ?? "image/jpeg",
      asset.fileName ?? `photo-${Date.now()}.jpg`,
      asset.fileSize,
    );
  }, [stageIfValid]);

  const startRecording = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError("permissionDenied");
      return;
    }
    setError(null);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stopRecording = useCallback(async () => {
    await recorder.stop();
    if (recorder.uri) {
      stageIfValid("voice", recorder.uri, "audio/m4a", `voice-note-${Date.now()}.m4a`, undefined);
      setAttachment((prev) =>
        prev && prev.kind === "voice"
          ? { ...prev, durationMillis: recorderState.durationMillis }
          : prev,
      );
    }
  }, [recorder, recorderState.durationMillis, stageIfValid]);

  const cancelRecording = useCallback(async () => {
    await recorder.stop();
    setAttachment(null);
  }, [recorder]);

  const clearAttachment = useCallback(() => {
    setAttachment(null);
    setError(null);
  }, []);

  const stageSharedPhoto = useCallback(
    (uri: string, mimeType: string, fileName: string) => {
      stageIfValid("photo", uri, mimeType, fileName);
    },
    [stageIfValid],
  );

  return {
    attachment,
    error,
    recording: recorderState.isRecording,
    recordingMillis: recorderState.durationMillis,
    pickFromGallery,
    takePhoto,
    startRecording,
    stopRecording,
    cancelRecording,
    clearAttachment,
    stageSharedPhoto,
    dismissError,
  };
}
