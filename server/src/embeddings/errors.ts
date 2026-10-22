/**
 * Typed embedding errors, mirroring `transcription/errors.ts`'s shape:
 * every error carries the provider name, but never the API key used to
 * call it.
 */
export abstract class EmbeddingError extends Error {
  readonly provider: string;

  protected constructor(provider: string, message: string) {
    super(message);
    this.provider = provider;
    this.name = this.constructor.name;
  }
}

/**
 * An HTTP-level failure: the provider rejected the request (4xx) or
 * failed unexpectedly (5xx). `body` is a short excerpt of the response
 * for debugging — never the request we sent, so it can never echo back
 * the Authorization header.
 */
export class EmbeddingHttpError extends EmbeddingError {
  readonly statusCode: number;
  readonly body: string;

  constructor(provider: string, statusCode: number, body: string) {
    super(provider, `${provider} request failed with HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** The request did not complete within the configured timeout. */
export class EmbeddingTimeoutError extends EmbeddingError {
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(provider, `${provider} embedding request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}
