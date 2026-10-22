import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ChangeGroupSummary } from "../../../../api/types";
import { ChangeRow } from "../change-row";

const change: ChangeGroupSummary = {
  groupId: "g1",
  source: "manual_edit",
  createdAt: "2026-10-22T00:00:00.000Z",
  undone: false,
  summary: "1 memory updated",
};

describe("ChangeRow", () => {
  it("calls onUndo when the undo action is pressed", async () => {
    const onUndo = jest.fn();
    await render(
      <ChangeRow
        change={change}
        undoLabel="Undo"
        undoneLabel="Undone"
        undoing={false}
        onUndo={onUndo}
      />,
    );

    await fireEvent.press(screen.getByTestId("change-undo-g1"));

    expect(onUndo).toHaveBeenCalled();
  });

  it("shows the undone label instead of an undo button once the group is fully undone", async () => {
    await render(
      <ChangeRow
        change={{ ...change, undone: true }}
        undoLabel="Undo"
        undoneLabel="Undone"
        undoing={false}
        onUndo={jest.fn()}
      />,
    );

    expect(screen.queryByTestId("change-undo-g1")).toBeNull();
    expect(screen.getByText("Undone")).toBeTruthy();
  });
});
