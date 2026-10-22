/**
 * Groq adapter: OpenAI-compatible audio transcription, used for chat
 * voice notes. The endpoint is synchronous (no job/poll lifecycle), and
 * Whisper does not diarize, so every segment's `speaker` is `null`.
 *
 * Docs relied on (current as of 2026-10-22):
 * - https://console.groq.com/docs/speech-to-text
 * - https://console.groq.com/docs/api-reference#audio-transcription
 */
import { fileNameFor, readAudioBuffer } from "./audio-input.js";
import { readJsonOrThrow } from "./http.js";
import type { TranscribeInput, Transcriber, Transcript, TranscriptSegment } from "./types.js";

const PROVIDER = "groq";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const MODEL = "whisper-large-v3-turbo";

// Groq's `prompt` field (capped at 224 tokens) guides style/spelling; it
// is documented as the way to bias recognition toward given vocabulary,
// unlike AssemblyAI's `word_boost` or Speechmatics' `additional_vocab`,
// which are structured keyword lists rather than free text.
const KEYTERMS_PROMPT_PREFIX = "Likely names and words in this audio: ";

export interface GroqTranscriberOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Accepted for a constructor shape uniform with the other adapters; unused because this endpoint is synchronous (no polling). */
  pollIntervalMs?: number;
  /** Accepted for a constructor shape uniform with the other adapters; unused because this endpoint is synchronous (no polling). */
  timeoutMs?: number;
}

interface GroqSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface GroqVerboseJsonResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: GroqSegment[];
}

export function createGroqTranscriber(options: GroqTranscriberOptions): Transcriber {
  const { apiKey, fetch: fetchFn = fetch } = options;

  async function transcribe(input: TranscribeInput): Promise<Transcript> {
    const bytes = await readAudioBuffer(input.audio);
    const fileName = fileNameFor(input.audio, input.mimeType);

    const form = new FormData();
    form.set("file", new Blob([bytes], { type: input.mimeType }), fileName);
    form.set("model", MODEL);
    form.set("language", input.language);
    form.set("response_format", "verbose_json");
    if (input.keyterms && input.keyterms.length > 0) {
      form.set("prompt", `${KEYTERMS_PROMPT_PREFIX}${input.keyterms.join(", ")}`);
    }

    const response = await fetchFn(`${DEFAULT_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = (await readJsonOrThrow(response, PROVIDER)) as GroqVerboseJsonResponse;

    return toNormalizedTranscript(body, input);
  }

  return { transcribe };
}

function toNormalizedTranscript(body: GroqVerboseJsonResponse, input: TranscribeInput): Transcript {
  return {
    provider: PROVIDER,
    model: MODEL,
    // Whisper's verbose_json `language` is a full language name (e.g.
    // "spanish"), not the ISO 639-1 code we requested and that the other
    // two adapters report. `language` stays in ISO 639-1 consistently
    // across every provider, so the requested input language wins here
    // rather than the echoed field.
    language: input.language,
    durationMs: Math.round((body.duration ?? 0) * 1000),
    segments: toSegments(body),
    raw: body,
  };
}

function toSegments(body: GroqVerboseJsonResponse): TranscriptSegment[] {
  if (body.segments && body.segments.length > 0) {
    return body.segments.map((segment) => ({
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      speaker: null,
      text: segment.text.trim(),
      // Whisper's verbose_json segments document no [0, 1] confidence
      // field (only `avg_logprob`, a log probability on a different
      // scale), so `confidence` is intentionally left unset rather than
      // invented from it.
    }));
  }

  if (!body.text) {
    return [];
  }

  return [
    {
      startMs: 0,
      endMs: Math.round((body.duration ?? 0) * 1000),
      speaker: null,
      text: body.text.trim(),
    },
  ];
}
