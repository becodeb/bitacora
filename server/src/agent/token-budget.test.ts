import { describe, expect, it } from "vitest";
import {
  estimateTokensForText,
  fitHistoryToBudget,
  MAX_INPUT_TOKEN_BUDGET,
} from "./token-budget.js";
import type { AgentMessage } from "./types.js";

function userText(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolUse(id: string, name: string): AgentMessage {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] };
}

function toolResult(toolUseId: string, content: string): AgentMessage {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] };
}

function assistantText(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("fitHistoryToBudget", () => {
  it("keeps everything when it already fits", () => {
    const history = [userText("hola"), assistantText("hola de vuelta")];
    const { kept, droppedCount } = fitHistoryToBudget(history, 0);
    expect(kept).toEqual(history);
    expect(droppedCount).toBe(0);
  });

  it("drops a whole old exchange, never splitting a tool_use from its tool_result", () => {
    const oldExchange = [
      userText("primer mensaje"),
      assistantToolUse("toolu_1", "search"),
      toolResult("toolu_1", "resultado"),
      assistantText("primera respuesta"),
    ];
    const recentExchange = [userText("segundo mensaje"), assistantText("segunda respuesta")];
    const history = [...oldExchange, ...recentExchange];

    // Reserve just enough that only the most recent exchange fits.
    const recentTokens =
      estimateTokensForText("segundo mensaje") + estimateTokensForText("segunda respuesta");
    const { kept, droppedCount } = fitHistoryToBudget(history, 0, recentTokens + 10);

    expect(kept).toEqual(recentExchange);
    expect(droppedCount).toBe(oldExchange.length);
    // No orphan tool_result and no leading assistant message.
    expect(kept[0]?.role).toBe("user");
    expect(kept[0]?.content.every((b) => b.type === "text")).toBe(true);
  });

  it("never returns a result starting with an orphan tool_result or a leading assistant message", () => {
    // A malformed/pre-existing-bug history fragment: starts mid-exchange.
    const malformed = [toolResult("toolu_x", "huerfano"), assistantText("respuesta huerfana")];
    const validExchange = [userText("mensaje válido"), assistantText("respuesta válida")];
    const history = [...malformed, ...validExchange];

    const { kept, droppedCount } = fitHistoryToBudget(history, 0, MAX_INPUT_TOKEN_BUDGET);

    expect(kept).toEqual(validExchange);
    expect(droppedCount).toBe(malformed.length);
  });

  it("drops down to an empty result rather than keep a fragment with no proper start", () => {
    const malformed = [toolResult("toolu_x", "huerfano")];
    const { kept, droppedCount } = fitHistoryToBudget(malformed, 0, MAX_INPUT_TOKEN_BUDGET);

    expect(kept).toEqual([]);
    expect(droppedCount).toBe(1);
  });

  it("drops multiple old exchanges in order until the budget fits", () => {
    const exchangeA = [userText("A".repeat(300))];
    const exchangeB = [userText("B".repeat(300))];
    const exchangeC = [userText("C")];
    const history = [...exchangeA, ...exchangeB, ...exchangeC];

    const cTokens = estimateTokensForText("C");
    const { kept, droppedCount } = fitHistoryToBudget(history, 0, cTokens + 5);

    expect(kept).toEqual(exchangeC);
    expect(droppedCount).toBe(2);
  });
});
