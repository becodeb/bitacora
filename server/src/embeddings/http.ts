import { EmbeddingHttpError } from "./errors.js";

const ERROR_BODY_EXCERPT_LIMIT = 500;

/**
 * Parses `response` as JSON, or throws `EmbeddingHttpError` for any
 * non-2xx status. Mirrors `transcription/http.ts`'s `readJsonOrThrow`.
 */
export async function readJsonOrThrow(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) {
    throw new EmbeddingHttpError(provider, response.status, await readBodyExcerpt(response));
  }
  return response.json();
}

async function readBodyExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, ERROR_BODY_EXCERPT_LIMIT);
  } catch {
    return "";
  }
}
