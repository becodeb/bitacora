import { describe, expect, it } from "vitest";
import { createAssemblyAiTranscriber } from "./assemblyai.js";
import {
  ProviderFailureError,
  TranscriptionHttpError,
  TranscriptionTimeoutError,
} from "./errors.js";
import completedResponse from "./fixtures/assemblyai-transcript-completed.json" with {
  type: "json",
};
import errorResponse from "./fixtures/assemblyai-transcript-error.json" with { type: "json" };
import queuedResponse from "./fixtures/assemblyai-transcript-queued.json" with { type: "json" };
import uploadResponse from "./fixtures/assemblyai-upload-response.json" with { type: "json" };
import { FetchRecorder, jsonResponse, textResponse } from "./test-helpers.js";

const API_KEY = "test-assemblyai-key";

describe("createAssemblyAiTranscriber", () => {
  it("uploads, creates the transcript with diarization and keyterms, polls, and maps utterances to normalized segments", async () => {
    let pollCount = 0;
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/v2/upload")) {
        return jsonResponse(uploadResponse);
      }
      if (url.endsWith("/v2/transcript")) {
        return jsonResponse(queuedResponse, 201);
      }
      if (url.includes("/v2/transcript/")) {
        pollCount += 1;
        return jsonResponse(pollCount === 1 ? queuedResponse : completedResponse);
      }
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const transcriber = createAssemblyAiTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });

    const transcript = await transcriber.transcribe({
      audio: Buffer.from("fake-audio-bytes"),
      mimeType: "audio/aac",
      language: "es",
      diarize: true,
      speakersExpected: 2,
      keyterms: ["Juan", "María"],
    });

    const [uploadCall, createCall] = recorder.calls;
    expect(uploadCall?.url).toBe("https://api.assemblyai.com/v2/upload");
    expect(uploadCall?.method).toBe("POST");
    expect(uploadCall?.headers.get("authorization")).toBe(API_KEY);
    expect(uploadCall?.headers.get("content-type")).toBe("application/octet-stream");

    expect(createCall?.url).toBe("https://api.assemblyai.com/v2/transcript");
    expect(createCall?.method).toBe("POST");
    expect(createCall?.headers.get("authorization")).toBe(API_KEY);
    expect(createCall?.body).toEqual({
      audio_url: uploadResponse.upload_url,
      language_code: "es",
      speaker_labels: true,
      speakers_expected: 2,
      word_boost: ["Juan", "María"],
      boost_param: "high",
    });

    expect(pollCount).toBeGreaterThanOrEqual(2);

    expect(transcript.provider).toBe("assemblyai");
    expect(transcript.model).toBe("best");
    expect(transcript.language).toBe("es");
    expect(transcript.durationMs).toBe(completedResponse.audio_duration * 1000);
    expect(transcript.segments).toHaveLength(3);
    expect(transcript.segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1"]);
    const firstUtterance = completedResponse.utterances[0];
    if (!firstUtterance) throw new Error("fixture missing utterances[0]");
    expect(transcript.segments[0]).toEqual({
      startMs: firstUtterance.start,
      endMs: firstUtterance.end,
      speaker: "S1",
      text: firstUtterance.text,
      confidence: firstUtterance.confidence,
    });
    expect(transcript.raw).toEqual(completedResponse);
  });

  it("falls back to a single null-speaker segment built from the overall text when diarize is false", async () => {
    const noDiarization = { ...completedResponse, utterances: null };
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/v2/upload")) return jsonResponse(uploadResponse);
      if (url.endsWith("/v2/transcript")) return jsonResponse(queuedResponse, 201);
      return jsonResponse(noDiarization);
    });

    const transcriber = createAssemblyAiTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
    });

    const transcript = await transcriber.transcribe({
      audio: Buffer.from("x"),
      mimeType: "audio/aac",
      language: "es",
      diarize: false,
    });

    const createCall = recorder.calls[1];
    expect(createCall?.body).toEqual({
      audio_url: uploadResponse.upload_url,
      language_code: "es",
      speaker_labels: false,
    });
    expect(transcript.segments).toEqual([
      {
        startMs: 0,
        endMs: completedResponse.audio_duration * 1000,
        speaker: null,
        text: completedResponse.text,
        confidence: completedResponse.confidence,
      },
    ]);
  });

  it("throws ProviderFailureError carrying AssemblyAI's own error message when status is 'error'", async () => {
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/v2/upload")) return jsonResponse(uploadResponse);
      if (url.endsWith("/v2/transcript")) return jsonResponse(queuedResponse, 201);
      return jsonResponse(errorResponse);
    });

    const transcriber = createAssemblyAiTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
    });

    let caught: unknown;
    try {
      await transcriber.transcribe({
        audio: Buffer.from("x"),
        mimeType: "audio/aac",
        language: "es",
        diarize: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderFailureError);
    const error = caught as ProviderFailureError;
    expect(error.provider).toBe("assemblyai");
    expect(error.status).toBe("error");
    expect(error.detail).toBe(errorResponse.error);
  });

  it("throws TranscriptionHttpError on a non-2xx response", async () => {
    const recorder = new FetchRecorder(() => textResponse("unauthorized", 401));
    const transcriber = createAssemblyAiTranscriber({ apiKey: API_KEY, fetch: recorder.fetch });

    await expect(
      transcriber.transcribe({
        audio: Buffer.from("x"),
        mimeType: "audio/aac",
        language: "es",
        diarize: false,
      }),
    ).rejects.toThrow(TranscriptionHttpError);
  });

  it("throws TranscriptionTimeoutError when the transcript never leaves 'processing'", async () => {
    const stillProcessing = {
      ...completedResponse,
      status: "processing" as const,
      utterances: null,
    };
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/v2/upload")) return jsonResponse(uploadResponse);
      if (url.endsWith("/v2/transcript")) return jsonResponse(queuedResponse, 201);
      return jsonResponse(stillProcessing);
    });

    const transcriber = createAssemblyAiTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
      timeoutMs: 5,
    });

    await expect(
      transcriber.transcribe({
        audio: Buffer.from("x"),
        mimeType: "audio/aac",
        language: "es",
        diarize: true,
      }),
    ).rejects.toThrow(TranscriptionTimeoutError);
  });
});
