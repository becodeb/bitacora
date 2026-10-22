/**
 * Speechmatics adapter: batch jobs API (create job -> poll -> fetch
 * transcript), with speaker diarization and custom vocabulary.
 *
 * Docs relied on (current as of 2026-10-22):
 * - OpenAPI spec (source of truth for request/response shapes, status
 *   codes, and the JobDetails/TranscriptionConfig schemas):
 *     https://docs.speechmatics.com/batch.yaml
 * - Batch output format (json-v2):          https://docs.speechmatics.com/speech-to-text/batch/output
 * - Custom dictionary (`additional_vocab`): https://docs.speechmatics.com/features/custom-dictionary
 * - Default endpoint and auth scheme:       https://docs.speechmatics.com/introduction/authentication
 */
import { fileNameFor, readAudioBuffer } from "./audio-input.js";
import { ProviderFailureError } from "./errors.js";
import { readJsonOrThrow } from "./http.js";
import { pollUntilDone } from "./poll.js";
import {
  groupSpeechmaticsResultsIntoSegments,
  type SpeechmaticsResultItem,
} from "./speechmatics-segments.js";
import type { TranscribeInput, Transcriber, Transcript } from "./types.js";

const PROVIDER = "speechmatics";

// On-demand (pay-as-you-go) default endpoint. Enterprise accounts on a
// dedicated region (eu1/eu2/us1/us2/au1) are out of scope for the MVP's
// single bake-off account.
const DEFAULT_BASE_URL = "https://asr.api.speechmatics.com/v2";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// Speechmatics' effective default operating model when `operating_point`
// is left unset in transcription_config, which this adapter always does.
const DEFAULT_MODEL = "enhanced";

export interface SpeechmaticsTranscriberOptions {
  apiKey: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

type SpeechmaticsJobStatus = "running" | "done" | "rejected" | "deleted" | "expired";

interface SpeechmaticsCreateJobResponse {
  id: string;
}

interface SpeechmaticsJobDetails {
  id: string;
  status: SpeechmaticsJobStatus;
  duration?: number;
  errors?: Array<{ timestamp?: string; message?: string }>;
}

interface SpeechmaticsJobInfoResponse {
  job: SpeechmaticsJobDetails;
}

interface SpeechmaticsTranscript {
  job?: {
    duration?: number;
    config?: {
      transcription_config?: {
        language?: string;
      };
    };
  };
  results: SpeechmaticsResultItem[];
}

export function createSpeechmaticsTranscriber(
  options: SpeechmaticsTranscriberOptions,
): Transcriber {
  const {
    apiKey,
    fetch: fetchFn = fetch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  async function transcribe(input: TranscribeInput): Promise<Transcript> {
    const jobId = await createJob(input);

    const jobDetails = await pollUntilDone<SpeechmaticsJobDetails>({
      provider: PROVIDER,
      pollIntervalMs,
      timeoutMs,
      poll: async () => {
        const details = await getJob(jobId);
        return details.status === "running" ? { done: false } : { done: true, result: details };
      },
    });

    if (jobDetails.status !== "done") {
      throw new ProviderFailureError(PROVIDER, jobDetails.status, jobDetails.errors?.[0]?.message);
    }

    const transcript = await getTranscript(jobId);
    return toNormalizedTranscript(transcript, input);
  }

  async function createJob(input: TranscribeInput): Promise<string> {
    const bytes = await readAudioBuffer(input.audio);
    const fileName = fileNameFor(input.audio, input.mimeType);

    const transcriptionConfig: Record<string, unknown> = { language: input.language };
    if (input.diarize) {
      transcriptionConfig.diarization = "speaker";
    }
    if (input.keyterms && input.keyterms.length > 0) {
      transcriptionConfig.additional_vocab = input.keyterms.map((content) => ({ content }));
    }

    const form = new FormData();
    form.set(
      "config",
      JSON.stringify({ type: "transcription", transcription_config: transcriptionConfig }),
    );
    form.set("data_file", new Blob([bytes], { type: input.mimeType }), fileName);

    const response = await fetchFn(`${DEFAULT_BASE_URL}/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = (await readJsonOrThrow(response, PROVIDER)) as SpeechmaticsCreateJobResponse;
    return body.id;
  }

  async function getJob(id: string): Promise<SpeechmaticsJobDetails> {
    const response = await fetchFn(`${DEFAULT_BASE_URL}/jobs/${id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = (await readJsonOrThrow(response, PROVIDER)) as SpeechmaticsJobInfoResponse;
    return body.job;
  }

  async function getTranscript(id: string): Promise<SpeechmaticsTranscript> {
    const response = await fetchFn(`${DEFAULT_BASE_URL}/jobs/${id}/transcript?format=json-v2`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return (await readJsonOrThrow(response, PROVIDER)) as SpeechmaticsTranscript;
  }

  return { transcribe };
}

function toNormalizedTranscript(
  transcript: SpeechmaticsTranscript,
  input: TranscribeInput,
): Transcript {
  const segments = groupSpeechmaticsResultsIntoSegments(transcript.results, input.diarize);
  const durationSeconds = transcript.job?.duration ?? lastEndTimeSeconds(transcript.results);

  return {
    provider: PROVIDER,
    model: DEFAULT_MODEL,
    language: transcript.job?.config?.transcription_config?.language ?? input.language,
    durationMs: Math.round(durationSeconds * 1000),
    segments,
    raw: transcript,
  };
}

function lastEndTimeSeconds(results: SpeechmaticsResultItem[]): number {
  return results.length === 0 ? 0 : (results[results.length - 1]?.end_time ?? 0);
}
