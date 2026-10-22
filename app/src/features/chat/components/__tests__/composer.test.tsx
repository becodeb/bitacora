import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ComposerProps } from "../composer";
import { Composer } from "../composer";

function baseProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    placeholder: "Write…",
    sendLabel: "Send",
    disabled: false,
    onSend: jest.fn(),
    attachment: null,
    onRemoveAttachment: jest.fn(),
    onPickPhoto: jest.fn(),
    onTakePhoto: jest.fn(),
    attachPhotoLabel: "Attach a photo",
    takePhotoLabel: "Take a photo",
    removeAttachmentLabel: "Remove attachment",
    photoAttachedLabel: "Photo attached",
    voiceAttachedLabel: "Voice note attached",
    recording: false,
    onStartRecording: jest.fn(),
    onStopRecording: jest.fn(),
    onCancelRecording: jest.fn(),
    recordLabel: "Record a voice note",
    stopRecordingLabel: "Stop recording",
    cancelRecordingLabel: "Cancel recording",
    recordingInProgressLabel: "Recording… 0s",
    ...overrides,
  };
}

describe("Composer", () => {
  it("calls onSend with the trimmed draft and no attachment, and clears the input", async () => {
    const onSend = jest.fn();
    await render(<Composer {...baseProps({ onSend })} />);

    await fireEvent.changeText(screen.getByTestId("composer-input"), "  hola  ");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledWith("hola", null);
  });

  it("does not call onSend for an empty or whitespace-only draft with no attachment", async () => {
    const onSend = jest.fn();
    await render(<Composer {...baseProps({ onSend })} />);

    await fireEvent.changeText(screen.getByTestId("composer-input"), "   ");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables sending while a turn is already in flight", async () => {
    const onSend = jest.fn();
    await render(<Composer {...baseProps({ onSend, disabled: true })} />);

    await fireEvent.changeText(screen.getByTestId("composer-input"), "hola");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a staged attachment with an empty caption, and clears it afterwards", async () => {
    const onSend = jest.fn();
    const onRemoveAttachment = jest.fn();
    await render(
      <Composer
        {...baseProps({
          onSend,
          onRemoveAttachment,
          attachment: {
            kind: "photo",
            uri: "file:///x.jpg",
            mimeType: "image/jpeg",
            fileName: "x.jpg",
          },
        })}
      />,
    );

    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ kind: "photo", uri: "file:///x.jpg" }),
    );
    expect(onRemoveAttachment).toHaveBeenCalled();
  });

  it("sends a staged attachment together with a caption", async () => {
    const onSend = jest.fn();
    await render(
      <Composer
        {...baseProps({
          onSend,
          attachment: {
            kind: "voice",
            uri: "file:///x.m4a",
            mimeType: "audio/m4a",
            fileName: "x.m4a",
          },
        })}
      />,
    );

    await fireEvent.changeText(screen.getByTestId("composer-input"), "el examen es el martes");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledWith(
      "el examen es el martes",
      expect.objectContaining({ kind: "voice" }),
    );
  });

  it("shows a stop and cancel control while recording, hiding the attach/camera/mic row", async () => {
    const onStopRecording = jest.fn();
    const onCancelRecording = jest.fn();
    await render(
      <Composer {...baseProps({ recording: true, onStopRecording, onCancelRecording })} />,
    );

    expect(screen.queryByTestId("composer-start-recording")).toBeNull();

    await fireEvent.press(screen.getByTestId("composer-stop-recording"));
    expect(onStopRecording).toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("composer-cancel-recording"));
    expect(onCancelRecording).toHaveBeenCalled();
  });

  it("re-stages the draft text when prefillVersion is bumped", async () => {
    const { rerender } = await render(
      <Composer {...baseProps({ prefillText: "shared text", prefillVersion: 1 })} />,
    );
    expect(screen.getByTestId("composer-input").props.value).toBe("shared text");

    await rerender(<Composer {...baseProps({ prefillText: "shared text", prefillVersion: 2 })} />);
    expect(screen.getByTestId("composer-input").props.value).toBe("shared text");
  });
});
