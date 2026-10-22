import { describe, expect, it } from "vitest";
import {
  ProviderFailureError,
  TranscriptionHttpError,
  TranscriptionTimeoutError,
} from "./errors.js";
import createJobResponse from "./fixtures/speechmatics-create-job-response.json" with {
  type: "json",
};
import jobDone from "./fixtures/speechmatics-job-done.json" with { type: "json" };
import jobRejected from "./fixtures/speechmatics-job-rejected.json" with { type: "json" };
import jobRunning from "./fixtures/speechmatics-job-running.json" with { type: "json" };
import transcriptJsonV2 from "./fixtures/speechmatics-transcript-json-v2.json" with {
  type: "json",
};
import { createSpeechmaticsTranscriber } from "./speechmatics.js";
import { FetchRecorder, jsonResponse, textResponse } from "./test-helpers.js";

const API_KEY = "test-speechmatics-key";

describe("createSpeechmaticsTranscriber", () => {
  it("sends the documented create-job request, polls, and maps the json-v2 transcript to normalized segments", async () => {
    let jobInfoCalls = 0;
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/jobs")) {
        return jsonResponse(createJobResponse, 201);
      }
      if (url.includes("/transcript")) {
        return jsonResponse(transcriptJsonV2);
      }
      if (url.includes("/jobs/")) {
        jobInfoCalls += 1;
        return jsonResponse(jobInfoCalls === 1 ? jobRunning : jobDone);
      }
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const transcriber = createSpeechmaticsTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });

    const audioBytes = Buffer.from("fake-audio-bytes");
    const transcript = await transcriber.transcribe({
      audio: audioBytes,
      mimeType: "audio/aac",
      language: "es",
      diarize: true,
      keyterms: ["Juan", "María"],
    });

    const createCall = recorder.calls[0];
    expect(createCall?.url).toBe("https://asr.api.speechmatics.com/v2/jobs");
    expect(createCall?.method).toBe("POST");
    expect(createCall?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(createCall?.body).toEqual({
      config: {
        type: "transcription",
        transcription_config: {
          language: "es",
          diarization: "speaker",
          additional_vocab: [{ content: "Juan" }, { content: "María" }],
        },
      },
      data_file: { blob: true, type: "audio/aac", size: audioBytes.length },
    });

    expect(jobInfoCalls).toBeGreaterThanOrEqual(2);

    expect(transcript.provider).toBe("speechmatics");
    expect(transcript.model).toBe("enhanced");
    expect(transcript.language).toBe("es");
    expect(transcript.durationMs).toBe(9_000);
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments.map((s) => s.speaker)).toEqual(["S1", "S2"]);
    expect(transcript.segments[0]).toMatchObject({
      startMs: 160,
      endMs: 1900,
      text: "Hola Juan, qué hora llegás?",
    });
    expect(transcript.segments[1]).toMatchObject({
      startMs: 2500,
      endMs: 4400,
      text: "Llego a las ocho, no hay problema.",
    });
    expect(transcript.raw).toEqual(transcriptJsonV2);
  });

  it("omits diarization and additional_vocab from the job config when not requested", async () => {
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/jobs")) return jsonResponse(createJobResponse, 201);
      if (url.includes("/transcript")) return jsonResponse(transcriptJsonV2);
      return jsonResponse(jobDone);
    });

    const transcriber = createSpeechmaticsTranscriber({
      apiKey: API_KEY,
      fetch: recorder.fetch,
      pollIntervalMs: 1,
    });

    await transcriber.transcribe({
      audio: Buffer.from("x"),
      mimeType: "audio/aac",
      language: "es",
      diarize: false,
    });

    expect(recorder.calls[0]?.body).toEqual({
      config: { type: "transcription", transcription_config: { language: "es" } },
      data_file: { blob: true, type: "audio/aac", size: 1 },
    });
  });

  it("throws ProviderFailureError carrying the job's own error message when the job is rejected", async () => {
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/jobs")) return jsonResponse(createJobResponse, 201);
      return jsonResponse(jobRejected);
    });

    const transcriber = createSpeechmaticsTranscriber({
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
    expect(error.provider).toBe("speechmatics");
    expect(error.status).toBe("rejected");
    expect(error.detail).toBe(jobRejected.job.errors?.[0]?.message);
  });

  it("throws TranscriptionHttpError on a non-2xx response", async () => {
    const recorder = new FetchRecorder(() => textResponse("forbidden", 403));
    const transcriber = createSpeechmaticsTranscriber({ apiKey: API_KEY, fetch: recorder.fetch });

    await expect(
      transcriber.transcribe({
        audio: Buffer.from("x"),
        mimeType: "audio/aac",
        language: "es",
        diarize: false,
      }),
    ).rejects.toThrow(TranscriptionHttpError);
  });

  it("throws TranscriptionTimeoutError when the job never leaves 'running'", async () => {
    const recorder = new FetchRecorder((url) => {
      if (url.endsWith("/jobs")) return jsonResponse(createJobResponse, 201);
      return jsonResponse(jobRunning);
    });

    const transcriber = createSpeechmaticsTranscriber({
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
