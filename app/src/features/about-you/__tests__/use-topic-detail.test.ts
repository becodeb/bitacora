import { renderHook, waitFor } from "@testing-library/react-native";
import type { ApiClient } from "../../../api/client";
import { useTopicDetail } from "../use-topic-detail";

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTopic: jest.fn(),
    getMemoriesWithoutTopic: jest.fn(),
    correctMemoryContent: jest.fn(),
    moveMemoryTopic: jest.fn(),
    deleteMemory: jest.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

const sampleMemory = {
  id: "m1",
  content: "Estudia Ingeniería en Sistemas",
  topicId: "t1",
  sourceEntryId: "e1",
  createdAt: "2026-10-22T00:00:00.000Z",
  validFrom: "2026-10-22T00:00:00.000Z",
};

describe("useTopicDetail", () => {
  it("fetches a topic and its memories when given a topicId", async () => {
    const getTopic = jest.fn().mockResolvedValue({
      ok: true,
      topic: {
        id: "t1",
        name: "University",
        description: null,
        summary: null,
        liveMemoryCount: 1,
        lastChangeAt: "x",
      },
      memories: [sampleMemory],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const client = fakeClient({ getTopic });

    const { result } = await renderHook(() => useTopicDetail(client, "t1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getTopic).toHaveBeenCalledWith("t1");
    expect(result.current.topic?.name).toBe("University");
    expect(result.current.memories).toEqual([sampleMemory]);
  });

  it("fetches the 'no topic' bucket when topicId is null", async () => {
    const getMemoriesWithoutTopic = jest
      .fn()
      .mockResolvedValue({ ok: true, memories: [sampleMemory], total: 1, limit: 20, offset: 0 });
    const client = fakeClient({ getMemoriesWithoutTopic });

    const { result } = await renderHook(() => useTopicDetail(client, null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getMemoriesWithoutTopic).toHaveBeenCalled();
    expect(result.current.topic).toBeNull();
    expect(result.current.memories).toEqual([sampleMemory]);
  });

  it("fetches nothing while topicId is undefined (no selection yet)", async () => {
    const getTopic = jest.fn();
    const getMemoriesWithoutTopic = jest.fn();
    const client = fakeClient({ getTopic, getMemoriesWithoutTopic });

    await renderHook(() => useTopicDetail(client, undefined));

    expect(getTopic).not.toHaveBeenCalled();
    expect(getMemoriesWithoutTopic).not.toHaveBeenCalled();
  });

  it("editMemoryContent corrects content, reloads, and returns the groupId", async () => {
    const getTopic = jest.fn().mockResolvedValue({
      ok: true,
      topic: {
        id: "t1",
        name: "University",
        description: null,
        summary: null,
        liveMemoryCount: 1,
        lastChangeAt: "x",
      },
      memories: [sampleMemory],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const correctMemoryContent = jest.fn().mockResolvedValue({ ok: true, groupId: "g1" });
    const client = fakeClient({ getTopic, correctMemoryContent });

    const { result } = await renderHook(() => useTopicDetail(client, "t1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const groupId = await result.current.editMemoryContent("m1", "Nuevo contenido");

    expect(correctMemoryContent).toHaveBeenCalledWith("m1", "Nuevo contenido");
    expect(getTopic).toHaveBeenCalledTimes(2);
    expect(groupId).toBe("g1");
  });

  it("deleteMemory removes it and reloads", async () => {
    const getTopic = jest.fn().mockResolvedValue({
      ok: true,
      topic: {
        id: "t1",
        name: "University",
        description: null,
        summary: null,
        liveMemoryCount: 1,
        lastChangeAt: "x",
      },
      memories: [sampleMemory],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const deleteMemory = jest.fn().mockResolvedValue({ ok: true, groupId: "g2" });
    const client = fakeClient({ getTopic, deleteMemory });

    const { result } = await renderHook(() => useTopicDetail(client, "t1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const groupId = await result.current.deleteMemory("m1");

    expect(deleteMemory).toHaveBeenCalledWith("m1");
    expect(groupId).toBe("g2");
  });
});
