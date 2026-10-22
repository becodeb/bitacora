const mockFetch = jest.fn();

jest.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

import { ApiClient } from "../client";
import { ApiError, NetworkError } from "../types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ApiClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends the bearer token on every authenticated call", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true, messages: [] }));
    const client = new ApiClient({ baseUrl: "http://192.168.1.5:3000", token: "secret-token" });

    await client.getChatHistory();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://192.168.1.5:3000/v1/chat/history",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("strips a trailing slash from the configured base URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true, db: "up" }));
    const client = new ApiClient({ baseUrl: "http://host:3000/", token: "t" });

    await client.checkHealth();

    expect(mockFetch).toHaveBeenCalledWith("http://host:3000/health", expect.anything());
  });

  it("checkHealth resolves false (not throws) on a network failure", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Network request failed"));
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    await expect(client.checkHealth()).resolves.toBe(false);
  });

  it("checkAuth resolves false on a 401", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { ok: false, error: "unauthorized" }));
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "wrong" });

    await expect(client.checkAuth()).resolves.toBe(false);
  });

  it("throws ApiError with the server's message on a non-2xx JSON response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { ok: false, error: "not found" }));
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    await expect(client.getEntry("missing")).rejects.toMatchObject({
      name: "ApiError",
      message: "not found",
      status: 404,
    });
  });

  it("wraps a transport failure in NetworkError for a non-probe call", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Network request failed"));
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    await expect(client.getChatHistory()).rejects.toThrow(NetworkError);
  });

  it("streams typed SSE events for sendTextMessage", async () => {
    const sseBody =
      'event: text\ndata: hola\n\nevent: done\ndata: {"turnId":"t1","stopReason":"end_turn","usage":{},"derivationPending":false}\n\n';
    mockFetch.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    const events: unknown[] = [];
    await client.sendTextMessage("hola", (event) => events.push(event));

    expect(events).toEqual([
      { event: "text", data: "hola" },
      {
        event: "done",
        data: { turnId: "t1", stopReason: "end_turn", usage: {}, derivationPending: false },
      },
    ]);
  });

  // `expo-expo`/jest's test environment's global `FormData` is a
  // web-standard polyfill that insists a file part be a real `Blob`;
  // React Native's own `FormData` (what `client.ts` actually runs
  // against on-device — see its own comment) accepts the plain
  // `{ uri, name, type }` shape with no such check. A fake standing in
  // for RN's own polyfill lets these two tests check the client's
  // choice of field names/shape without fighting that mismatch.
  class FakeFormData {
    parts: Array<[string, unknown]> = [];
    append(key: string, value: unknown) {
      this.parts.push([key, value]);
    }
    get(key: string) {
      return this.parts.find(([k]) => k === key)?.[1] ?? null;
    }
  }

  it("sendAttachmentMessage builds a multipart body with the 'file' and 'caption' fields the server expects", async () => {
    const originalFormData = globalThis.FormData;
    // @ts-expect-error -- test-only stand-in, see FakeFormData's doc above.
    globalThis.FormData = FakeFormData;
    try {
      const sseBody =
        'event: done\ndata: {"turnId":"t1","stopReason":"end_turn","usage":{},"derivationPending":false}\n\n';
      mockFetch.mockResolvedValueOnce(
        new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
      const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

      await client.sendAttachmentMessage(
        { uri: "file:///photo.jpg", mimeType: "image/jpeg", fileName: "photo.jpg" },
        "el examen es el martes",
        () => {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://host:3000/v1/chat");
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FakeFormData);
      const form = init.body as unknown as FakeFormData;
      expect(form.get("file")).toMatchObject({
        uri: "file:///photo.jpg",
        name: "photo.jpg",
        type: "image/jpeg",
      });
      expect(form.get("caption")).toBe("el examen es el martes");
      // No manual content-type header: letting fetch set the multipart
      // boundary itself is required for the server to parse the body.
      expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    } finally {
      globalThis.FormData = originalFormData;
    }
  });

  it("sendAttachmentMessage omits the 'caption' field when there is no caption text", async () => {
    const originalFormData = globalThis.FormData;
    // @ts-expect-error -- test-only stand-in, see FakeFormData's doc above.
    globalThis.FormData = FakeFormData;
    try {
      mockFetch.mockResolvedValueOnce(
        new Response(
          'event: done\ndata: {"turnId":"t1","stopReason":"end_turn","usage":{},"derivationPending":false}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
      const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

      await client.sendAttachmentMessage(
        { uri: "file:///note.m4a", mimeType: "audio/m4a", fileName: "note.m4a" },
        "",
        () => {},
      );

      const form = mockFetch.mock.calls[0][1].body as unknown as FakeFormData;
      expect(form.get("caption")).toBeNull();
    } finally {
      globalThis.FormData = originalFormData;
    }
  });

  it("throws the JSON error body instead of opening the SSE decoder on a 4xx chat response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, { ok: false, error: "JSON body must include a non-empty 'text' string" }),
    );
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    await expect(client.sendTextMessage("", () => {})).rejects.toThrow(ApiError);
  });
});
