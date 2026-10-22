/**
 * Typed transcription errors. Every error carries the provider name so
 * callers (and logs) can tell providers apart without string-matching a
 * message, but never carries the API key used to call that provider:
 * messages are built only from the provider name, a status/code, and
 * provider-returned text, never from request headers or the key itself.
 */
export abstract class TranscriptionError extends Error {
  readonly provider: string;

  protected constructor(provider: string, message: string) {
    super(message);
    this.provider = provider;
    this.name = this.constructor.name;
  }
}

/**
 * The provider accepted the request, but its own status field reports
 * that the transcription itself failed — AssemblyAI's `status: "error"`,
 * or a Speechmatics job whose `status` settled on `"rejected"` (or
 * `"deleted"`/`"expired"`). Distinct from `TranscriptionHttpError`,
 * which is an HTTP-level failure (the request itself was rejected).
 */
export class ProviderFailureError extends TranscriptionError {
  /** The provider's own status value, e.g. "error" or "rejected". */
  readonly status: string;
  readonly detail: string | undefined;

  constructor(provider: string, status: string, detail?: string) {
    super(
      provider,
      detail
        ? `${provider} reported transcription failure (status: ${status}): ${detail}`
        : `${provider} reported transcription failure (status: ${status})`,
    );
    this.status = status;
    this.detail = detail;
  }
}

/**
 * An HTTP-level failure: the provider rejected the request itself (4xx)
 * or failed unexpectedly (5xx). `body` is a short excerpt of the
 * response for debugging — never the request we sent, so it can never
 * echo back the Authorization header.
 */
export class TranscriptionHttpError extends TranscriptionError {
  readonly statusCode: number;
  readonly body: string;

  constructor(provider: string, statusCode: number, body: string) {
    super(provider, `${provider} request failed with HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Polling never reached a terminal state within `timeoutMs`. */
export class TranscriptionTimeoutError extends TranscriptionError {
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(provider, `${provider} polling timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}
