import { fireEvent, render, screen } from "@testing-library/react-native";
import type { MemorySummary, TopicOverview } from "../../../../api/types";
import { MemoryRow, type MemoryRowProps } from "../memory-row";

const memory: MemorySummary = {
  id: "m1",
  content: "Estudia Ingeniería en Sistemas",
  topicId: "t1",
  sourceEntryId: "e1",
  createdAt: "x",
  validFrom: "x",
};

const otherTopic: TopicOverview = {
  id: "t2",
  name: "Work",
  description: null,
  summary: null,
  liveMemoryCount: 0,
  lastChangeAt: "x",
};

function baseProps(overrides: Partial<MemoryRowProps> = {}): MemoryRowProps {
  return {
    memory,
    otherTopics: [otherTopic],
    editLabel: "Edit",
    saveLabel: "Save",
    cancelLabel: "Cancel",
    moveLabel: "Move",
    moveToNoTopicLabel: "No topic",
    deleteLabel: "Delete",
    citationLabel: "Source",
    onSaveContent: jest.fn(),
    onMove: jest.fn(),
    onDelete: jest.fn(),
    onOpenCitation: jest.fn(),
    ...overrides,
  };
}

describe("MemoryRow", () => {
  it("saves edited content when Save is pressed after editing", async () => {
    const onSaveContent = jest.fn();
    await render(<MemoryRow {...baseProps({ onSaveContent })} />);

    await fireEvent.press(screen.getByTestId("memory-content-m1"));
    await fireEvent.changeText(screen.getByTestId("memory-edit-input-m1"), "Nuevo contenido");
    await fireEvent.press(screen.getByTestId("memory-save-m1"));

    expect(onSaveContent).toHaveBeenCalledWith("Nuevo contenido");
  });

  it("does not call onSaveContent when the edited content is unchanged", async () => {
    const onSaveContent = jest.fn();
    await render(<MemoryRow {...baseProps({ onSaveContent })} />);

    await fireEvent.press(screen.getByTestId("memory-content-m1"));
    await fireEvent.press(screen.getByTestId("memory-save-m1"));

    expect(onSaveContent).not.toHaveBeenCalled();
  });

  it("calls onMove with the chosen topic id after opening the move picker", async () => {
    const onMove = jest.fn();
    await render(<MemoryRow {...baseProps({ onMove })} />);

    await fireEvent.press(screen.getByTestId("memory-move-toggle-m1"));
    await fireEvent.press(screen.getByTestId("memory-move-to-t2"));

    expect(onMove).toHaveBeenCalledWith("t2");
  });

  it("calls onMove with null when 'No topic' is chosen", async () => {
    const onMove = jest.fn();
    await render(<MemoryRow {...baseProps({ onMove })} />);

    await fireEvent.press(screen.getByTestId("memory-move-toggle-m1"));
    await fireEvent.press(screen.getByTestId("memory-move-to-none-m1"));

    expect(onMove).toHaveBeenCalledWith(null);
  });

  it("calls onDelete when the delete action is pressed", async () => {
    const onDelete = jest.fn();
    await render(<MemoryRow {...baseProps({ onDelete })} />);

    await fireEvent.press(screen.getByTestId("memory-delete-m1"));

    expect(onDelete).toHaveBeenCalled();
  });

  it("calls onOpenCitation when the source chip is pressed", async () => {
    const onOpenCitation = jest.fn();
    await render(<MemoryRow {...baseProps({ onOpenCitation })} />);

    await fireEvent.press(screen.getByTestId("memory-citation-m1"));

    expect(onOpenCitation).toHaveBeenCalled();
  });
});
