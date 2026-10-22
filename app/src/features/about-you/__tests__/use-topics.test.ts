import { renderHook, waitFor } from "@testing-library/react-native";
import type { ApiClient } from "../../../api/client";
import { useTopics } from "../use-topics";

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTopics: jest.fn().mockResolvedValue({ ok: true, topics: [] }),
    renameTopic: jest.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("useTopics", () => {
  it("loads topics on mount", async () => {
    const topics = [
      {
        id: "t1",
        name: "University",
        description: null,
        summary: "Studies",
        liveMemoryCount: 3,
        lastChangeAt: "2026-10-22T00:00:00.000Z",
      },
    ];
    const client = fakeClient({ getTopics: jest.fn().mockResolvedValue({ ok: true, topics }) });

    const { result } = await renderHook(() => useTopics(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.topics).toEqual(topics);
  });

  it("renameTopic calls the client, reloads the list, and returns the groupId", async () => {
    const renameTopic = jest.fn().mockResolvedValue({ ok: true, groupId: "g1", topic: {} });
    const getTopics = jest.fn().mockResolvedValue({ ok: true, topics: [] });
    const client = fakeClient({ renameTopic, getTopics });

    const { result } = await renderHook(() => useTopics(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const groupId = await result.current.renameTopic("t1", "Nuevo nombre");

    expect(renameTopic).toHaveBeenCalledWith("t1", { name: "Nuevo nombre" });
    expect(getTopics).toHaveBeenCalledTimes(2); // initial load + reload after rename
    expect(groupId).toBe("g1");
  });

  it("surfaces an error and leaves topics empty on failure", async () => {
    const client = fakeClient({ getTopics: jest.fn().mockRejectedValue(new Error("boom")) });

    const { result } = await renderHook(() => useTopics(client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.topics).toEqual([]);
  });
});
