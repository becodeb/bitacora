import { describe, expect, it } from "vitest";
import { TranscriptionHttpError } from "./errors.js";
import verboseJsonResponse from "./fixtures/groq-verbose-json.json" with { type: "json" };
import { createGroqTranscriber } from "./groq.js";
import { FetchRecorder, jsonResponse, textResponse } from "./test-helpers.js";

const API_KEY = "test-groq-key";

describe("createGroqTranscriber", () => {
  it("sends the documented multipart request and maps segments with a null speaker", async () => {
    const recorder = new FetchRecorder(() => jsonResponse(verboseJsonResponse));

    const transcriber = createGroqTranscriber({ apiKey: API_KEY, fetch: recorder.fetch });

    const audioBytes = Buffer.from("fake-audio-bytes");
    const transcript = await transcriber.transcribe({
      audio: audioBytes,
      mimeType: "audio/mp4",
      language: "es",
      diarize: true, // Groq cannot diarize; this must be ignored, not forwarded or treated as an error.
      keyterms: ["Juan", "María"],
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.body).toMatchObject({
      model: "whisper-large-v3-turbo",
      language: "es",
      response_format: "verbose_json",
      prompt: "Likely names and words in this audio: Juan, María",
      file: { blob: true, type: "audio/mp4", size: audioBytes.length },
    });

    expect(transcript.provider).toBe("groq");
    expect(transcript.model).toBe("whisper-large-v3-turbo");
    // The fixture's body.language is "spanish"; the adapter must prefer the ISO code we requested instead.
    expect(transcript.language).toBe("es");
    expect(transcript.durationMs).toBe(Math.round(verboseJsonResponse.duration * 1000));
    expect(transcript.segments).toHaveLength(verboseJsonResponse.segments.length);
    expect(transcript.segments.every((segment) => segment.speaker === null)).toBe(true);
    const firstSegment = verboseJsonResponse.segments[0];
    if (!firstSegment) throw new Error("fixture missing segments[0]");
    expect(transcript.segments[0]).toMatchObject({
      startMs: Math.round(firstSegment.start * 1000),
      endMs: Math.round(firstSegment.end * 1000),
      speaker: null,
      text: firstSegment.text.trim(),
    });
    expect(transcript.segments[0]).not.toHaveProperty("confidence");
    expect(transcript.raw).toEqual(verboseJsonResponse);
  });

  it("omits the prompt field when there are no keyterms", async () => {
    const recorder = new FetchRecorder(() => jsonResponse(verboseJsonResponse));
    const transcriber = createGroqTranscriber({ apiKey: API_KEY, fetch: recorder.fetch });

    await transcriber.transcribe({
      audio: Buffer.from("x"),
      mimeType: "audio/mp4",
      language: "es",
      diarize: false,
    });

    expect(recorder.calls[0]?.body).not.toHaveProperty("prompt");
  });

  it("throws TranscriptionHttpError on a non-2xx response", async () => {
    const recorder = new FetchRecorder(() => textResponse("invalid api key", 401));
    const transcriber = createGroqTranscriber({ apiKey: "bad-key", fetch: recorder.fetch });

    await expect(
      transcriber.transcribe({
        audio: Buffer.from("x"),
        mimeType: "audio/mp4",
        language: "es",
        diarize: false,
      }),
    ).rejects.toThrow(TranscriptionHttpError);
  });

  it("falls back to a single whole-text segment when the response has no segments array", async () => {
    const recorder = new FetchRecorder(() =>
      jsonResponse({ text: "Dale, nos vemos.", language: "spanish", duration: 2.4 }),
    );
    const transcriber = createGroqTranscriber({ apiKey: API_KEY, fetch: recorder.fetch });

    const transcript = await transcriber.transcribe({
      audio: Buffer.from("x"),
      mimeType: "audio/mp4",
      language: "es",
      diarize: false,
    });

    expect(transcript.segments).toEqual([
      { startMs: 0, endMs: 2400, speaker: null, text: "Dale, nos vemos." },
    ]);
  });
});
