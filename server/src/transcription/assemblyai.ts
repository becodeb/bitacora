/**
 * AssemblyAI adapter: async v2 API (upload -> create transcript -> poll
 * until completion), with speaker diarization.
 *
 * Docs relied on (current as of 2026-10-22):
 * - Upload:            https://www.assemblyai.com/docs/api-reference/files/upload
 * - Create transcript: https://www.assemblyai.com/docs/api-reference/transcripts/submit
 * - Get transcript:    https://www.assemblyai.com/docs/api-reference/transcripts/get
 * - Word boost (custom vocabulary): https://www.assemblyai.com/docs/faq/how-can-i-make-certain-words-more-likely-to-be-transcribed
 *
 * Deliberately NOT AssemblyAI's newer synchronous `/transcribe` endpoint
 * (Universal-3.5 Pro): that endpoint is capped at 80ms-120s of audio and
 * its documented request schema has no `speaker_labels` field, so it
 * cannot diarize, which this adapter needs.
 */
import { readAudioBuffer } from "./audio-input.js";
import { ProviderFailureError } from "./errors.js";
import { readJsonOrThrow } from "./http.js";
import { pollUntilDone } from "./poll.js";
import { normalizeSpeakerLabels } from "./speaker-labels.js";
import type { TranscribeInput, Transcriber, Transcript, TranscriptSegment } from "./types.js";

const PROVIDER = "assemblyai";
const DEFAULT_BASE_URL = "https://api.assemblyai.com";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000; // Batch transcription of a long recording is not instant.

// AssemblyAI's documented default speech model when `speech_model` is
// not set in the request, which this adapter never does.
const DEFAULT_MODEL = "best";

export interface AssemblyAiTranscriberOptions {
  apiKey: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface AssemblyAiUploadResponse {
  upload_url: string;
}

interface AssemblyAiWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string | null;
}

interface AssemblyAiUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: AssemblyAiWord[];
}

interface AssemblyAiTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string | null;
  audio_duration?: number | null;
  language_code?: string | null;
  text?: string | null;
  confidence?: number | null;
  utterances?: AssemblyAiUtterance[] | null;
}

export function createAssemblyAiTranscriber(options: AssemblyAiTranscriberOptions): Transcriber {
  const {
    apiKey,
    fetch: fetchFn = fetch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  async function transcribe(input: TranscribeInput): Promise<Transcript> {
    const uploadUrl = await upload(input);
    const transcriptId = await createTranscript(uploadUrl, input);

    const transcript = await pollUntilDone<AssemblyAiTranscript>({
      provider: PROVIDER,
      pollIntervalMs,
      timeoutMs,
      poll: async () => {
        const current = await getTranscript(transcriptId);
        if (current.status === "completed" || current.status === "error") {
          return { done: true, result: current };
        }
        return { done: false };
      },
    });

    if (transcript.status === "error") {
      throw new ProviderFailureError(PROVIDER, "error", transcript.error ?? undefined);
    }

    return toNormalizedTranscript(transcript, input);
  }

  async function upload(input: TranscribeInput): Promise<string> {
    const bytes = await readAudioBuffer(input.audio);
    const response = await fetchFn(`${DEFAULT_BASE_URL}/v2/upload`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const body = (await readJsonOrThrow(response, PROVIDER)) as AssemblyAiUploadResponse;
    return body.upload_url;
  }

  async function createTranscript(audioUrl: string, input: TranscribeInput): Promise<string> {
    const requestBody: Record<string, unknown> = {
      audio_url: audioUrl,
      language_code: input.language,
      speaker_labels: input.diarize,
    };

    if (input.diarize && input.speakersExpected !== undefined) {
      requestBody.speakers_expected = input.speakersExpected;
    }
    if (input.keyterms && input.keyterms.length > 0) {
      requestBody.word_boost = input.keyterms;
      requestBody.boost_param = "high";
    }

    const response = await fetchFn(`${DEFAULT_BASE_URL}/v2/transcript`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const body = (await readJsonOrThrow(response, PROVIDER)) as { id: string };
    return body.id;
  }

  async function getTranscript(id: string): Promise<AssemblyAiTranscript> {
    const response = await fetchFn(`${DEFAULT_BASE_URL}/v2/transcript/${id}`, {
      method: "GET",
      headers: { Authorization: apiKey },
    });
    return (await readJsonOrThrow(response, PROVIDER)) as AssemblyAiTranscript;
  }

  return { transcribe };
}

function toNormalizedTranscript(
  transcript: AssemblyAiTranscript,
  input: TranscribeInput,
): Transcript {
  return {
    provider: PROVIDER,
    model: DEFAULT_MODEL,
    language: transcript.language_code ?? input.language,
    // `audio_duration` is in seconds; every timestamp elsewhere in this
    // response (utterance and word start/end) is already in milliseconds.
    durationMs: Math.round((transcript.audio_duration ?? 0) * 1000),
    segments: toSegments(transcript, input.diarize),
    raw: transcript,
  };
}

function toSegments(transcript: AssemblyAiTranscript, diarize: boolean): TranscriptSegment[] {
  if (!diarize || !transcript.utterances || transcript.utterances.length === 0) {
    if (!transcript.text) {
      return [];
    }
    return [
      {
        startMs: 0,
        endMs: Math.round((transcript.audio_duration ?? 0) * 1000),
        speaker: null,
        text: transcript.text,
        confidence: transcript.confidence ?? undefined,
      },
    ];
  }

  const normalizedSpeakers = normalizeSpeakerLabels(
    transcript.utterances.map((utterance) => utterance.speaker),
  );

  return transcript.utterances.map((utterance, index) => ({
    startMs: utterance.start,
    endMs: utterance.end,
    speaker: normalizedSpeakers[index] ?? null,
    text: utterance.text,
    confidence: utterance.confidence,
  }));
}
