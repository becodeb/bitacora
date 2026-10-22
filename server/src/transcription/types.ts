/**
 * Provider-independent transcription domain types.
 *
 * Every adapter under `transcription/` (AssemblyAI, Speechmatics, Groq)
 * normalizes its provider's response into these types, so the rest of
 * the server (extraction, the processing pipeline) never has to branch
 * on which provider produced a given transcript.
 */

/** The transcription providers this server integrates with. */
export type TranscriptionProviderName = "assemblyai" | "speechmatics" | "groq";

/**
 * One contiguous span of speech attributed to a single speaker.
 *
 * `speaker` is a normalized label (`S1`, `S2`, …) assigned in order of
 * first appearance within a single transcript, or `null` when the
 * transcript has no diarization — either the provider cannot diarize at
 * all (Groq), or the caller did not request it (`diarize: false`). Raw
 * provider speaker labels (AssemblyAI's `A`/`B`, Speechmatics'
 * `S1`/`S2`) are never exposed directly, so callers never need to know
 * which provider ran.
 */
export interface TranscriptSegment {
  /** Start of the segment, in milliseconds from the start of the audio. */
  startMs: number;
  /** End of the segment, in milliseconds from the start of the audio. */
  endMs: number;
  speaker: string | null;
  text: string;
  /** Provider-reported confidence in [0, 1], when the provider documents one. */
  confidence?: number;
}

/** A normalized transcript, regardless of which provider produced it. */
export interface Transcript {
  provider: TranscriptionProviderName;
  /** The specific model/tier the provider used, e.g. "best", "enhanced", "whisper-large-v3-turbo". */
  model: string;
  /** ISO 639-1 language code, e.g. "es". */
  language: string;
  durationMs: number;
  segments: TranscriptSegment[];
  /**
   * The provider's raw, unmodified response, kept only for debugging.
   * Optional, and deliberately not read by any normal caller, so no one
   * is tempted to depend on a provider-specific shape.
   */
  raw?: unknown;
}

/** A name or word that helps a provider recognize vocabulary specific to the owner's conversations. */
export type Keyterm = string;

export interface TranscribeInput {
  /** A path to the audio file, or its bytes already in memory. */
  audio: string | Buffer;
  /** The audio's MIME type, e.g. "audio/aac", "audio/mp4", "audio/wav". */
  mimeType: string;
  /** ISO 639-1 language code, e.g. "es". */
  language: string;
  /**
   * Whether to request speaker diarization. Providers that cannot
   * diarize (Groq) ignore this and always return `speaker: null`.
   */
  diarize: boolean;
  /**
   * A hint for how many distinct speakers to expect. Only meaningful
   * together with `diarize: true`, and only for providers that document
   * support for it.
   */
  speakersExpected?: number;
  /** Names and words that help recognition, such as the people the owner talks to. */
  keyterms?: Keyterm[];
}

/**
 * The transcription port. Every adapter under `transcription/`
 * implements this, and only this, so callers depend on no
 * provider-specific detail.
 */
export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<Transcript>;
}
