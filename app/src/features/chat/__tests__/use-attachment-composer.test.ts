const mockRequestMediaLibraryPermissions = jest.fn();
const mockRequestCameraPermissions = jest.fn();
const mockLaunchImageLibrary = jest.fn();
const mockLaunchCamera = jest.fn();

jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) =>
    mockRequestMediaLibraryPermissions(...args),
  requestCameraPermissionsAsync: (...args: unknown[]) => mockRequestCameraPermissions(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
  launchCameraAsync: (...args: unknown[]) => mockLaunchCamera(...args),
}));

const mockRequestRecordingPermissions = jest.fn();
const mockPrepareToRecordAsync = jest.fn();
const mockRecord = jest.fn();
const mockStop = jest.fn();

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: (...args: unknown[]) =>
    mockRequestRecordingPermissions(...args),
  useAudioRecorder: () => ({
    prepareToRecordAsync: mockPrepareToRecordAsync,
    record: mockRecord,
    stop: mockStop,
    uri: "file:///recording.m4a",
  }),
  useAudioRecorderState: () => ({ isRecording: false, durationMillis: 1500 }),
}));

import { act, renderHook } from "@testing-library/react-native";
import { useAttachmentComposer } from "../use-attachment-composer";

describe("useAttachmentComposer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stages a gallery photo once permission is granted and the mime type is allowed", async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ granted: true });
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///a.jpg", mimeType: "image/jpeg", fileName: "a.jpg", fileSize: 1000 }],
    });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.pickFromGallery();
    });

    expect(result.current.attachment).toMatchObject({ kind: "photo", uri: "file:///a.jpg" });
    expect(result.current.error).toBeNull();
  });

  it("surfaces a permissionDenied error and stages nothing when gallery permission is refused", async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ granted: false });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.pickFromGallery();
    });

    expect(result.current.attachment).toBeNull();
    expect(result.current.error).toBe("permissionDenied");
    expect(mockLaunchImageLibrary).not.toHaveBeenCalled();
  });

  it("does nothing when the gallery picker is canceled", async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ granted: true });
    mockLaunchImageLibrary.mockResolvedValue({ canceled: true });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.pickFromGallery();
    });

    expect(result.current.attachment).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("rejects a photo over the client-side size allowlist with tooLarge, before any upload", async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ granted: true });
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///huge.jpg",
          mimeType: "image/jpeg",
          fileName: "huge.jpg",
          fileSize: 20 * 1024 * 1024,
        },
      ],
    });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.pickFromGallery();
    });

    expect(result.current.attachment).toBeNull();
    expect(result.current.error).toBe("tooLarge");
  });

  it("rejects an unsupported mime type with unsupportedMime", async () => {
    mockRequestCameraPermissions.mockResolvedValue({ granted: true });
    mockLaunchCamera.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///a.heic", mimeType: "image/heic", fileName: "a.heic" }],
    });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.takePhoto();
    });

    expect(result.current.attachment).toBeNull();
    expect(result.current.error).toBe("unsupportedMime");
  });

  it("stages a voice recording as .m4a once stopped, with its duration", async () => {
    mockRequestRecordingPermissions.mockResolvedValue({ granted: true });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.startRecording();
    });
    expect(mockPrepareToRecordAsync).toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalled();

    await act(async () => {
      await result.current.stopRecording();
    });

    expect(mockStop).toHaveBeenCalled();
    expect(result.current.attachment).toMatchObject({
      kind: "voice",
      uri: "file:///recording.m4a",
      mimeType: "audio/m4a",
      durationMillis: 1500,
    });
  });

  it("discards the recording and stages nothing on cancelRecording", async () => {
    mockRequestRecordingPermissions.mockResolvedValue({ granted: true });

    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.cancelRecording();
    });

    expect(mockStop).toHaveBeenCalled();
    expect(result.current.attachment).toBeNull();
  });

  it("stages a shared photo from outside the composer's own pickers (the share target)", async () => {
    const { result } = await renderHook(() => useAttachmentComposer());

    await act(() => {
      result.current.stageSharedPhoto("file:///shared.png", "image/png", "shared.png");
    });

    expect(result.current.attachment).toMatchObject({ kind: "photo", uri: "file:///shared.png" });
  });

  it("clearAttachment resets both the staged attachment and any error", async () => {
    mockRequestMediaLibraryPermissions.mockResolvedValue({ granted: false });
    const { result } = await renderHook(() => useAttachmentComposer());
    await act(async () => {
      await result.current.pickFromGallery();
    });
    expect(result.current.error).toBe("permissionDenied");

    await act(() => {
      result.current.clearAttachment();
    });

    expect(result.current.attachment).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
