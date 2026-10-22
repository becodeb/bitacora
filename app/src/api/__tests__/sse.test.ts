import { consumeChatStream, parseChatFrame, SseFrameDecoder } from "../sse";
import type { ChatStreamEvent } from "../types";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

describe("SseFrameDecoder", () => {
  it("parses a single complete frame", () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push("event: text\ndata: hola\n\n");
    expect(frames).toEqual([{ event: "text", data: "hola" }]);
  });

  it("buffers a frame split across two pushes (chunk boundary mid-frame)", () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push("event: te")).toEqual([]);
    const frames = decoder.push("xt\ndata: hola\n\n");
    expect(frames).toEqual([{ event: "text", data: "hola" }]);
  });

  it("buffers a frame split right at the blank-line terminator", () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push("event: text\ndata: hola\n")).toEqual([]);
    const frames = decoder.push("\n");
    expect(frames).toEqual([{ event: "text", data: "hola" }]);
  });

  it("emits multiple frames arriving in one chunk", () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push(
      "event: text\ndata: a\n\nevent: text\ndata: b\n\nevent: done\ndata: {}\n\n",
    );
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.event)).toEqual(["text", "text", "done"]);
  });

  it("joins multi-line data fields with newlines, per the SSE spec", () => {
    const decoder = new SseFrameDecoder();
    const frames = decoder.push("event: text\ndata: line one\ndata: line two\n\n");
    expect(frames).toEqual([{ event: "text", data: "line one\nline two" }]);
  });
});

describe("parseChatFrame", () => {
  it("parses a text frame as raw data", () => {
    expect(parseChatFrame({ event: "text", data: "hola" })).toEqual({
      event: "text",
      data: "hola",
    });
  });

  it("parses a tool frame's JSON payload", () => {
    const frame = { event: "tool", data: JSON.stringify({ name: "search", statusSummary: "…" }) };
    expect(parseChatFrame(frame)).toEqual({
      event: "tool",
      data: { name: "search", statusSummary: "…" },
    });
  });

  it("parses a citations frame", () => {
    const frame = {
      event: "citations",
      data: JSON.stringify({ ref: "1", sourceEntryId: "e1" }),
    };
    expect(parseChatFrame(frame)).toEqual({
      event: "citations",
      data: { ref: "1", sourceEntryId: "e1" },
    });
  });

  it("parses a done frame", () => {
    const payload = { turnId: "t1", stopReason: "end_turn", usage: {}, derivationPending: false };
    const frame = { event: "done", data: JSON.stringify(payload) };
    expect(parseChatFrame(frame)).toEqual({ event: "done", data: payload });
  });

  it("parses a well-formed error frame", () => {
    const frame = {
      event: "error",
      data: JSON.stringify({ code: "internal_error", message: "An internal error occurred." }),
    };
    expect(parseChatFrame(frame)).toEqual({
      event: "error",
      data: { code: "internal_error", message: "An internal error occurred." },
    });
  });

  it("falls back to a parse_error event for a malformed error frame", () => {
    const frame = { event: "error", data: "not json" };
    expect(parseChatFrame(frame)).toEqual({
      event: "error",
      data: { code: "parse_error", message: "not json" },
    });
  });

  it("drops a frame with malformed JSON on a non-error event", () => {
    expect(parseChatFrame({ event: "tool", data: "not json" })).toBeNull();
  });

  it("drops an unrecognized event name", () => {
    expect(parseChatFrame({ event: "ping", data: "x" })).toBeNull();
  });
});

describe("consumeChatStream", () => {
  it("decodes events from a stream chunked mid-frame and mid-UTF-8-character", () => {
    const full =
      'event: text\ndata: café\n\nevent: done\ndata: {"turnId":"t1","stopReason":"end_turn","usage":{},"derivationPending":false}\n\n';
    const bytes = new TextEncoder().encode(full);
    // "café" encodes as [..., 'f', 0xC3, 0xA9, ...] — split one byte past
    // "caf" so the two-byte UTF-8 sequence for "é" is cut in half.
    const splitPoint = new TextEncoder().encode("event: text\ndata: caf").length + 1;
    const chunkA = bytes.slice(0, splitPoint);
    const chunkB = bytes.slice(splitPoint);

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunkA);
        controller.enqueue(chunkB);
        controller.close();
      },
    });

    const events: ChatStreamEvent[] = [];
    return consumeChatStream(stream, (event) => events.push(event)).then(() => {
      expect(events[0]).toEqual({ event: "text", data: "café" });
      expect(events[1].event).toBe("done");
    });
  });

  it("surfaces an error event emitted mid-stream", async () => {
    const stream = streamFromChunks([
      "event: text\ndata: partial\n\n",
      'event: error\ndata: {"code":"internal_error","message":"boom"}\n\n',
    ]);
    const events: ChatStreamEvent[] = [];
    await consumeChatStream(stream, (event) => events.push(event));
    expect(events).toEqual([
      { event: "text", data: "partial" },
      { event: "error", data: { code: "internal_error", message: "boom" } },
    ]);
  });
});
