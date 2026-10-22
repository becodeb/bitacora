import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ApiClient } from "../../../api/client";
import type { ChatStreamEvent } from "../../../api/types";
import { useChatContainer } from "../use-chat";

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getChatHistory: jest.fn().mockResolvedValue({ ok: true, messages: [] }),
    undoLast: jest.fn().mockResolvedValue({ ok: true, reverted: 0 }),
    sendTextMessage: jest.fn().mockResolvedValue(undefined),
    getEntry: jest.fn(),
    checkHealth: jest.fn(),
    checkAuth: jest.fn(),
    sendEntryMessage: jest.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("useChatContainer", () => {
  it("loads history on mount and maps text content blocks", async () => {
    const client = fakeClient({
      getChatHistory: jest.fn().mockResolvedValue({
        ok: true,
        messages: [
          {
            id: "m1",
            role: "user",
            content: [{ type: "text", text: "hola" }],
            entryId: null,
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      }),
    });

    const { result } = await renderHook(() => useChatContainer(client));

    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "hola" });
  });

  it("does nothing when there is no configured client yet", async () => {
    const { result } = await renderHook(() => useChatContainer(null));
    await waitFor(() => expect(result.current.historyLoading).toBe(true));
    expect(result.current.messages).toEqual([]);
  });

  it("accumulates streamed text deltas into one growing assistant message", async () => {
    const events: ChatStreamEvent[] = [
      { event: "text", data: "Hola" },
      { event: "text", data: " mundo" },
      {
        event: "done",
        data: { turnId: "turn-1", stopReason: "end_turn", usage: {}, derivationPending: false },
      },
    ];
    const client = fakeClient({
      sendTextMessage: jest.fn(async (_text, onEvent) => {
        for (const event of events) {
          onEvent(event);
        }
      }),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    await act(async () => {
      await result.current.sendText("hi");
    });

    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.text).toBe("Hola mundo");
    expect(assistant?.pending).toBe(false);
    expect(assistant?.id).toBe("turn-1");
  });

  it("maps citation events into the pending assistant message's citation table", async () => {
    const events: ChatStreamEvent[] = [
      { event: "text", data: "Mira [#1]" },
      { event: "citations", data: { ref: "1", sourceEntryId: "entry-abc" } },
      {
        event: "done",
        data: { turnId: "turn-2", stopReason: "end_turn", usage: {}, derivationPending: false },
      },
    ];
    const client = fakeClient({
      sendTextMessage: jest.fn(async (_text, onEvent) => {
        for (const event of events) {
          onEvent(event);
        }
      }),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    await act(async () => {
      await result.current.sendText("hi");
    });

    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.citations).toEqual({ "1": "entry-abc" });
  });

  it("surfaces an error event and drops the in-progress assistant draft", async () => {
    const events: ChatStreamEvent[] = [
      { event: "text", data: "partial" },
      { event: "error", data: { code: "internal_error", message: "An internal error occurred." } },
    ];
    const client = fakeClient({
      sendTextMessage: jest.fn(async (_text, onEvent) => {
        for (const event of events) {
          onEvent(event);
        }
      }),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    await act(async () => {
      await result.current.sendText("hi");
    });

    expect(result.current.error).toBe("An internal error occurred.");
    expect(result.current.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("surfaces a thrown network error from the client", async () => {
    const client = fakeClient({
      sendTextMessage: jest.fn().mockRejectedValue(new Error("network")),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    await act(async () => {
      await result.current.sendText("hi");
    });

    expect(result.current.error).toBe("network");
    expect(result.current.sending).toBe(false);
  });

  it("undoLast calls the API and reloads history, reporting the reverted count", async () => {
    const client = fakeClient({
      getChatHistory: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, messages: [] })
        .mockResolvedValueOnce({ ok: true, messages: [] }),
      undoLast: jest.fn().mockResolvedValue({ ok: true, turnId: "t1", reverted: 2 }),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));

    await act(async () => {
      await result.current.undoLast();
    });

    expect(client.undoLast).toHaveBeenCalledTimes(1);
    expect(result.current.lastUndoResult).toEqual({ reverted: 2 });
  });

  it("canUndo is true only when the last message is from the assistant", async () => {
    const client = fakeClient({
      getChatHistory: jest.fn().mockResolvedValue({
        ok: true,
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            entryId: null,
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      }),
    });

    const { result } = await renderHook(() => useChatContainer(client));
    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(result.current.canUndo).toBe(true);
  });
});
