import type {
  ChatCitationEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatStreamEvent,
  ChatToolEvent,
} from "./types";

/**
 * A minimal Server-Sent Events frame decoder, written against the
 * exact `text`/`tool`/`citations`/`done`/`error` events
 * `server/src/http/chat.ts`'s `streamSSE` writes (via hono's
 * `hono/streaming`), not the full SSE spec (no `id:`/`retry:`
 * handling, no reconnection).
 *
 * **Why not `react-native-sse` or a generic EventSource.** Bitacora's
 * stream is a `POST` with a JSON/multipart body, not a plain `GET`;
 * React Native's own `fetch` (the polyfilled XHR-based one) buffers
 * the whole response before resolving, so it cannot stream at all.
 * `expo/fetch` (the WinterCG-compliant fetch Expo SDK 54+ ships,
 * confirmed current in SDK 58 docs) returns a real `Response.body`
 * `ReadableStream` on Android for any method, including `POST` with a
 * body — which is exactly `POST /v1/chat`'s shape — with no extra
 * native module. `react-native-sse` would still need a bridge
 * (`EventSource` wraps `XMLHttpRequest`, not `fetch`) to get the POST
 * body sent at all, and its streaming guarantees under Android's okhttp
 * are undocumented. `expo/fetch` was chosen as the fewer-moving-parts
 * option already in the SDK Bitacora targets.
 */

export interface SseFrame {
  event: string;
  data: string;
}

const FIELD_SEPARATOR = ":";

/**
 * Buffers raw SSE bytes across chunk boundaries and yields complete
 * frames. hono's `streamSSE` writes one `event: <name>\ndata: <data>\n\n`
 * block per call, but nothing guarantees a chunk boundary lines up with
 * a frame boundary (a `fetch` stream chunk is a transport artifact, not
 * a framing one) — a frame or even a single field can arrive split
 * across two `reader.read()` calls, so this only ever emits once a full
 * blank-line-terminated block has been seen.
 */
export class SseFrameDecoder {
  private buffer = "";

  /** Feeds one chunk of decoded text (already UTF-8 decoded) and returns any frames newly completed by it. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame) {
        frames.push(frame);
      }
      boundary = this.buffer.indexOf("\n\n");
    }

    return frames;
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      continue;
    }
    const sepIndex = line.indexOf(FIELD_SEPARATOR);
    const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
    const value = sepIndex === -1 ? "" : line.slice(sepIndex + 1).replace(/^ /, "");

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    // Other fields (id, retry, comments starting with ":") are ignored —
    // the server never sends them for this endpoint.
  }

  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join("\n") };
}

/** Parses one decoded SSE frame into the typed `ChatStreamEvent` union. Returns `null` for an unrecognized event name (forward-compatible: a future event is dropped, not crashed on) or malformed JSON on a JSON-carrying event. */
export function parseChatFrame(frame: SseFrame): ChatStreamEvent | null {
  switch (frame.event) {
    case "text":
      return { event: "text", data: frame.data };
    case "tool": {
      const data = safeJsonParse<ChatToolEvent>(frame.data);
      return data ? { event: "tool", data } : null;
    }
    case "citations": {
      const data = safeJsonParse<ChatCitationEvent>(frame.data);
      return data ? { event: "citations", data } : null;
    }
    case "done": {
      const data = safeJsonParse<ChatDoneEvent>(frame.data);
      return data ? { event: "done", data } : null;
    }
    case "error": {
      const data = safeJsonParse<ChatErrorEvent>(frame.data);
      return data
        ? { event: "error", data }
        : { event: "error", data: { code: "parse_error", message: frame.data } };
    }
    default:
      return null;
  }
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Reads a whole SSE response body, decoding bytes incrementally (so a
 * multi-byte UTF-8 character split across two chunks still decodes
 * correctly) and yielding typed events as complete frames arrive.
 * `onEvent` is called synchronously per event, in order.
 */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const frameDecoder = new SseFrameDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      for (const frame of frameDecoder.push(text)) {
        const event = parseChatFrame(frame);
        if (event) {
          onEvent(event);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
