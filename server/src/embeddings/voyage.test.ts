import { describe, expect, it, vi } from "vitest";
import { EmbeddingHttpError, EmbeddingTimeoutError } from "./errors.js";
import { createVoyageEmbedder } from "./voyage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a Voyage-shaped response for `texts.length` embeddings, each a distinct vector so tests can assert ordering. */
function fakeEmbeddingsResponse(count: number, shuffled = false) {
  const indexes = Array.from({ length: count }, (_, i) => i);
  const order = shuffled ? [...indexes].reverse() : indexes;
  return {
    object: "list",
    data: order.map((index) => ({
      object: "embedding",
      embedding: [index, index + 0.5],
      index,
    })),
    model: "voyage-3.5",
    usage: { total_tokens: count * 3 },
  };
}

describe("createVoyageEmbedder", () => {
  it("returns [] for an empty input without calling fetch", async () => {
    const fetchFn = vi.fn();
    const embedder = createVoyageEmbedder({ apiKey: "key", fetch: fetchFn });

    const result = await embedder.embed([], "document");

    expect(result).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends input_type, model and the batch, and returns vectors in request order", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(fakeEmbeddingsResponse(2)));
    const embedder = createVoyageEmbedder({ apiKey: "sk-test", fetch: fetchFn });

    const result = await embedder.embed(["hola", "mundo"], "query");

    expect(result).toEqual([
      [0, 0.5],
      [1, 1.5],
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(JSON.parse(init.body as string)).toEqual({
      input: ["hola", "mundo"],
      model: "voyage-3.5",
      input_type: "query",
    });
  });

  it("re-sorts a response whose embeddings arrive out of order", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(fakeEmbeddingsResponse(3, true)));
    const embedder = createVoyageEmbedder({ apiKey: "key", fetch: fetchFn });

    const result = await embedder.embed(["a", "b", "c"], "document");

    expect(result).toEqual([
      [0, 0.5],
      [1, 1.5],
      [2, 2.5],
    ]);
  });

  it("splits a large batch into multiple requests respecting batchSize", async () => {
    const fetchFn = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      return jsonResponse(fakeEmbeddingsResponse(body.input.length));
    });
    const embedder = createVoyageEmbedder({ apiKey: "key", fetch: fetchFn, batchSize: 2 });

    const result = await embedder.embed(["a", "b", "c", "d", "e"], "document");

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(5);
  });

  it("throws EmbeddingHttpError for a non-2xx response, without leaking the request", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    const embedder = createVoyageEmbedder({ apiKey: "secret-key", fetch: fetchFn });

    await expect(embedder.embed(["hola"], "document")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EmbeddingHttpError);
      const httpError = error as EmbeddingHttpError;
      expect(httpError.statusCode).toBe(429);
      expect(httpError.provider).toBe("voyage");
      expect(httpError.body).not.toContain("secret-key");
      return true;
    });
  });

  it("throws EmbeddingTimeoutError when the request does not complete in time", async () => {
    const fetchFn: typeof fetch = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    };
    const embedder = createVoyageEmbedder({ apiKey: "key", fetch: fetchFn, timeoutMs: 5 });

    await expect(embedder.embed(["hola"], "document")).rejects.toBeInstanceOf(
      EmbeddingTimeoutError,
    );
  });
});
