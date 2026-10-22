import { render, screen } from "@testing-library/react-native";
import { ToolActivityIndicator } from "../tool-activity-indicator";

describe("ToolActivityIndicator", () => {
  it("renders nothing when there is no status", async () => {
    await render(<ToolActivityIndicator statusSummary={null} />);
    expect(screen.queryByTestId("tool-activity-indicator")).toBeNull();
  });

  it("renders the status summary when present", async () => {
    await render(<ToolActivityIndicator statusSummary="Searching memories…" />);
    expect(screen.getByText("Searching memories…")).toBeTruthy();
  });
});
