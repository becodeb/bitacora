import { fireEvent, render, screen } from "@testing-library/react-native";
import { Composer } from "../composer";

describe("Composer", () => {
  it("calls onSend with the trimmed draft and clears the input", async () => {
    const onSend = jest.fn();
    await render(
      <Composer placeholder="Write…" sendLabel="Send" disabled={false} onSend={onSend} />,
    );

    await fireEvent.changeText(screen.getByTestId("composer-input"), "  hola  ");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledWith("hola");
  });

  it("does not call onSend for an empty or whitespace-only draft", async () => {
    const onSend = jest.fn();
    await render(
      <Composer placeholder="Write…" sendLabel="Send" disabled={false} onSend={onSend} />,
    );

    await fireEvent.changeText(screen.getByTestId("composer-input"), "   ");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables sending while a turn is already in flight", async () => {
    const onSend = jest.fn();
    await render(
      <Composer placeholder="Write…" sendLabel="Send" disabled={true} onSend={onSend} />,
    );

    await fireEvent.changeText(screen.getByTestId("composer-input"), "hola");
    await fireEvent.press(screen.getByTestId("composer-send"));

    expect(onSend).not.toHaveBeenCalled();
  });
});
