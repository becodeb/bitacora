/**
 * Test-only helpers shared by the transcription adapters' suites. Not
 * matched by Vitest's `src/**\/*.test.ts` include pattern in
 * `vitest.config.ts`, so this file is never itself run as a test.
 */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * A fake `fetch` that records every call it receives — URL, method,
 * headers, and a best-effort decoded body — before delegating to
 * `handler` for the response. Lets a test drive a real adapter end to
 * end and then assert on the exact outgoing requests, instead of each
 * test hand-rolling its own request-body-parsing logic.
 */
export class FetchRecorder {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  ) {}

  fetch: typeof fetch = async (input, init) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = await decodeBody(init?.body);
    this.calls.push({ url, method, headers, body });
    return this.handler(url, init ?? {});
  };
}

async function decodeBody(body: RequestInit["body"]): Promise<unknown> {
  if (body === null || body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return tryParseJson(body);
  }
  if (body instanceof FormData) {
    const entries: Record<string, unknown> = {};
    for (const [key, value] of body.entries()) {
      entries[key] =
        value instanceof Blob
          ? { blob: true, type: value.type, size: value.size }
          : tryParseJson(value);
    }
    return entries;
  }
  if (body instanceof Buffer || body instanceof Uint8Array) {
    return { bytes: body.length };
  }
  return body;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
