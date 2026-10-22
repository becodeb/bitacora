let mockShareIntentContext: {
  hasShareIntent: boolean;
  shareIntent: {
    text: string | null;
    files: Array<{ path: string; mimeType?: string; fileName?: string }>;
  };
  resetShareIntent: jest.Mock;
};

jest.mock("expo-share-intent", () => ({
  useShareIntentContext: () => mockShareIntentContext,
}));

import { renderHook } from "@testing-library/react-native";
import { useAttachmentComposer } from "../use-attachment-composer";
import { useShareIntentStaging } from "../use-share-intent-staging";

jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(),
  useAudioRecorder: () => ({
    prepareToRecordAsync: jest.fn(),
    record: jest.fn(),
    stop: jest.fn(),
    uri: null,
  }),
  useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0 }),
}));

/** Renders `useAttachmentComposer` and `useShareIntentStaging` together, as `app/(tabs)/chat.tsx` does. */
function renderStaging() {
  return renderHook(() => {
    const attachmentComposer = useAttachmentComposer();
    const staging = useShareIntentStaging(attachmentComposer);
    return { attachmentComposer, staging };
  });
}

describe("useShareIntentStaging", () => {
  it("stages a shared image file into the attachment composer and resets the share intent", async () => {
    const resetShareIntent = jest.fn();
    mockShareIntentContext = {
      hasShareIntent: true,
      shareIntent: {
        text: null,
        files: [{ path: "file:///shared.jpg", mimeType: "image/jpeg", fileName: "shared.jpg" }],
      },
      resetShareIntent,
    };

    const { result: hookResult } = await renderStaging();

    expect(hookResult.current.attachmentComposer.attachment).toMatchObject({
      kind: "photo",
      uri: "file:///shared.jpg",
    });
    expect(resetShareIntent).toHaveBeenCalled();
  });

  it("stages shared plain text as a composer prefill, bumping prefillVersion", async () => {
    const resetShareIntent = jest.fn();
    mockShareIntentContext = {
      hasShareIntent: true,
      shareIntent: { text: "el examen es el martes", files: [] },
      resetShareIntent,
    };

    const { result } = await renderStaging();

    expect(result.current.staging.prefillText).toBe("el examen es el martes");
    expect(result.current.staging.prefillVersion).toBe(1);
    expect(result.current.attachmentComposer.attachment).toBeNull();
    expect(resetShareIntent).toHaveBeenCalled();
  });

  it("does nothing when there is no pending share intent", async () => {
    mockShareIntentContext = {
      hasShareIntent: false,
      shareIntent: { text: null, files: [] },
      resetShareIntent: jest.fn(),
    };

    const { result } = await renderStaging();

    expect(result.current.staging.prefillText).toBeUndefined();
    expect(result.current.staging.prefillVersion).toBe(0);
  });
});
