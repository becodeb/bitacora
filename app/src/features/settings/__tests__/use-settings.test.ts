const mockFetch = jest.fn();
jest.mock("expo/fetch", () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockStore.delete(key);
    return Promise.resolve();
  }),
}));

import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useSettingsContainer } from "../use-settings";

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("useSettingsContainer", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStore.clear();
  });

  it("starts unconfigured when nothing is stored", async () => {
    const { result } = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(false);
    expect(result.current.client).toBeNull();
  });

  it("connect persists and configures only after both health and auth succeed", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true, db: "up" }));
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true }));

    const { result } = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let failure: string | null = null;
    await act(async () => {
      failure = await result.current.connect("http://192.168.1.5:3000", "secret");
    });

    expect(failure).toBeNull();
    expect(result.current.configured).toBe(true);
    expect(result.current.client).not.toBeNull();
  });

  it("connect reports 'unreachable' and does not persist when /health fails", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 503 }));

    const { result } = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let failure: string | null = null;
    await act(async () => {
      failure = await result.current.connect("http://host:3000", "secret");
    });

    expect(failure).toBe("unreachable");
    expect(result.current.configured).toBe(false);
  });

  it("connect reports 'unauthorized' when the token is rejected", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true, db: "up" }));
    mockFetch.mockResolvedValueOnce(okResponse({ ok: false, error: "unauthorized" }, 401));

    const { result } = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let failure: string | null = null;
    await act(async () => {
      failure = await result.current.connect("http://host:3000", "bad-token");
    });

    expect(failure).toBe("unauthorized");
    expect(result.current.configured).toBe(false);
  });

  it("reloads persisted settings on a fresh mount", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true, db: "up" }));
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true }));

    const first = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      await first.result.current.connect("http://host:3000", "secret");
    });

    const second = await renderHook(() => useSettingsContainer());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.configured).toBe(true);
    expect(second.result.current.baseUrl).toBe("http://host:3000");
  });
});
