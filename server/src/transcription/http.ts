import { TranscriptionHttpError } from "./errors.js";

const ERROR_BODY_EXCERPT_LIMIT = 500;

/**
 * Parses `response` as JSON, or throws `TranscriptionHttpError` for any
 * non-2xx status. The thrown error carries a short excerpt of the
 * response body for debugging — never the request, so it can never echo
 * back the Authorization header a caller sent.
 */
export async function readJsonOrThrow(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) {
    throw new TranscriptionHttpError(provider, response.status, await readBodyExcerpt(response));
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
