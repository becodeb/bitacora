import { fireEvent, render, screen } from "@testing-library/react-native";
import { MessageBubble } from "../message-bubble";

describe("MessageBubble", () => {
  it("renders plain user text", async () => {
    await render(
      <MessageBubble
        message={{
          id: "1",
          role: "user",
          text: "hola",
          citations: {},
          createdAt: "2026-10-22T00:00:00.000Z",
          pending: false,
        }}
        roleToolLabel="Tool step"
        onCitationPress={jest.fn()}
      />,
    );
    expect(screen.getByText("hola")).toBeTruthy();
  });

  it("renders a tool message as its subtle label, not a bubble", async () => {
    await render(
      <MessageBubble
        message={{
          id: "2",
          role: "tool",
          text: "",
          citations: {},
          createdAt: "2026-10-22T00:00:00.000Z",
          pending: false,
        }}
        roleToolLabel="Tool step"
        onCitationPress={jest.fn()}
      />,
    );
    expect(screen.getByText("Tool step")).toBeTruthy();
  });

  it("renders a tappable citation chip and calls onCitationPress with the mapped entry id", async () => {
    const onCitationPress = jest.fn();
    await render(
      <MessageBubble
        message={{
          id: "3",
          role: "assistant",
          text: "Mira [#1] por ejemplo",
          citations: { "1": "entry-abc" },
          createdAt: "2026-10-22T00:00:00.000Z",
          pending: false,
        }}
        roleToolLabel="Tool step"
        onCitationPress={onCitationPress}
      />,
    );

    await fireEvent.press(screen.getByTestId("citation-chip-1"));
    expect(onCitationPress).toHaveBeenCalledWith("1", "entry-abc");
  });

  it("renders an unmapped citation marker as plain text, not tappable", async () => {
    await render(
      <MessageBubble
        message={{
          id: "4",
          role: "assistant",
          text: "Ver [#9]",
          citations: {},
          createdAt: "2026-10-22T00:00:00.000Z",
          pending: false,
        }}
        roleToolLabel="Tool step"
        onCitationPress={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("citation-chip-9")).toBeNull();
    expect(screen.getByText("[#9]")).toBeTruthy();
  });

  it("shows a placeholder for an empty, still-pending assistant message", async () => {
    await render(
      <MessageBubble
        message={{
          id: "5",
          role: "assistant",
          text: "",
          citations: {},
          createdAt: "2026-10-22T00:00:00.000Z",
          pending: true,
        }}
        roleToolLabel="Tool step"
        onCitationPress={jest.fn()}
      />,
    );
    expect(screen.getByText("…")).toBeTruthy();
  });
});
