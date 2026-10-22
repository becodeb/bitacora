import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ApiClient } from "../../../api/client";
import { useChanges } from "../use-changes";

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getChanges: jest.fn().mockResolvedValue({ ok: true, changes: [] }),
    undoChangeGroup: jest.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("useChanges", () => {
  it("loads changes on mount", async () => {
    const changes = [
      {
        groupId: "g1",
        source: "manual_edit" as const,
        createdAt: "x",
        undone: false,
        summary: "1 memory updated",
      },
    ];
    const client = fakeClient({ getChanges: jest.fn().mockResolvedValue({ ok: true, changes }) });

    const { result } = await renderHook(() => useChanges(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.changes).toEqual(changes);
  });

  it("undo calls the client, sets lastUndoResult, and reloads", async () => {
    const undoChangeGroup = jest.fn().mockResolvedValue({ ok: true, turnId: "g1", reverted: 2 });
    const getChanges = jest.fn().mockResolvedValue({ ok: true, changes: [] });
    const client = fakeClient({ undoChangeGroup, getChanges });

    const { result } = await renderHook(() => useChanges(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.undo("g1");
    });

    expect(undoChangeGroup).toHaveBeenCalledWith("g1");
    expect(result.current.lastUndoResult).toEqual({ groupId: "g1", reverted: 2 });
    expect(result.current.undoingGroupId).toBeNull();
    expect(getChanges).toHaveBeenCalledTimes(2);
  });

  it("dismissUndoResult clears the snackbar state", async () => {
    const undoChangeGroup = jest.fn().mockResolvedValue({ ok: true, turnId: "g1", reverted: 1 });
    const client = fakeClient({ undoChangeGroup });

    const { result } = await renderHook(() => useChanges(client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.undo("g1");
    });
    expect(result.current.lastUndoResult).not.toBeNull();

    await act(() => {
      result.current.dismissUndoResult();
    });
    expect(result.current.lastUndoResult).toBeNull();
  });

  it("ignores a second undo call while one is already in flight for a different group", async () => {
    let resolveFirst: (() => void) | undefined;
    const undoChangeGroup = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, turnId: "g1", reverted: 1 });
        }),
    );
    const client = fakeClient({ undoChangeGroup });

    const { result } = await renderHook(() => useChanges(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.undo("g1");
      // Let `undo`'s synchronous `setUndoingGroupId(groupId)` flush
      // before the second call below reads it — `undoChangeGroup`'s
      // own promise for "g1" is still deliberately unresolved.
      await Promise.resolve();
    });
    expect(result.current.undoingGroupId).toBe("g1");
    await act(async () => {
      await result.current.undo("g2");
    });

    expect(undoChangeGroup).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst?.();
      await first;
    });
  });
});
