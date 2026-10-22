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

  it("throws the JSON error body instead of opening the SSE decoder on a 4xx chat response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, { ok: false, error: "JSON body must include a non-empty 'text' string" }),
    );
    const client = new ApiClient({ baseUrl: "http://host:3000", token: "t" });

    await expect(client.sendTextMessage("", () => {})).rejects.toThrow(ApiError);
  });
});
