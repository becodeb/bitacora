/**
 * Voyage AI adapter: REST embeddings, used for entries, memories, topics
 * and search queries (see `odd/tasks/mvp.md`, "Memory design" and
 * "Architecture" — Anthropic recommends Voyage because it has no
 * embedding model of its own).
 *
 * Docs relied on (current as of 2026-10-22, via context7 `/websites/voyageai`):
 * - https://docs.voyageai.com/reference/embeddings-api
 *   - `input`: a string or list of strings, max 1,000 per request.
 *   - `model`: `voyage-3.5` has a 320K-token-per-request limit.
 *   - `input_type`: `"query"` or `"document"`, each prepends a different
 *     internal prompt — must match the caller's intent.
 *   - `output_dimension`: defaults to 1,024 for `voyage-3.5`, which
 *     matches `EMBEDDING_DIMENSIONS` in `db/schema.ts`; left unset here
 *     rather than passed explicitly, so a schema change is the one place
 *     that has to agree with Voyage's default.
 *   - Response: `{ data: [{ embedding, index }], usage: { total_tokens } }`,
 *     one object per input, `index` giving its position in the request.
 */
import { EmbeddingTimeoutError } from "./errors.js";
import { readJsonOrThrow } from "./http.js";
import type { Embedder, EmbeddingInputType } from "./types.js";

const PROVIDER = "voyage";
const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";
const MODEL = "voyage-3.5";
const DEFAULT_TIMEOUT_MILLIS = 20_000;

/**
 * Voyage allows up to 1,000 texts and 320K tokens per `voyage-3.5`
 * request. This server's inputs (owner messages, memory facts, topic
 * descriptions) are short, so batching by count alone — well under the
 * 1,000 limit — keeps per-request tokens far below 320K without any
 * token counting.
 */
const DEFAULT_BATCH_SIZE = 100;

export interface VoyageEmbedderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  batchSize?: number;
}

interface VoyageEmbeddingObject {
  embedding: number[];
  index: number;
}

interface VoyageEmbeddingsResponse {
  data: VoyageEmbeddingObject[];
  model: string;
  usage: { total_tokens: number };
}

export function createVoyageEmbedder(options: VoyageEmbedderOptions): Embedder {
  const {
    apiKey,
    fetch: fetchFn = fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MILLIS,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  async function embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const vectors: number[][] = [];
    for (const batch of chunk(texts, batchSize)) {
      vectors.push(...(await embedBatch(batch, inputType)));
    }
    return vectors;
  }

  async function embedBatch(batch: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: batch, model: MODEL, input_type: inputType }),
        signal: controller.signal,
      });
      const body = (await readJsonOrThrow(response, PROVIDER)) as VoyageEmbeddingsResponse;

      return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new EmbeddingTimeoutError(PROVIDER, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { embed };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
