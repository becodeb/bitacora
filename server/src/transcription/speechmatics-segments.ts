import { normalizeSpeakerLabels } from "./speaker-labels.js";
import type { TranscriptSegment } from "./types.js";

/**
 * One item of Speechmatics' json-v2 `results` array: either a
 * recognized word or a punctuation mark, each with its own timing and a
 * list of alternatives (this adapter only ever reads the best, i.e.
 * first, one).
 *
 * Shape confirmed against the official OpenAPI spec:
 * https://docs.speechmatics.com/batch.yaml
 */
export interface SpeechmaticsResultItem {
  type: "word" | "punctuation";
  start_time: number;
  end_time: number;
  alternatives: Array<{
    content: string;
    confidence: number;
    speaker?: string;
    language?: string;
  }>;
  /**
   * Only present on punctuation items. Documented values: `"previous"`
   * (attaches with no space to the word before it, e.g. a comma),
   * `"next"` (attaches with no space to the word after it, e.g. an
   * opening currency symbol), `"both"` (no space on either side), or
   * `"none"` (stands alone, spaced on both sides).
   */
  attaches_to?: "previous" | "next" | "both" | "none";
}

interface SegmentBuilder {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  confidenceSum: number;
  confidenceCount: number;
}

/**
 * Groups Speechmatics' flat, word-by-word `results` array into one
 * segment per contiguous run of the same speaker, joining each run's
 * words and punctuation back into readable text.
 *
 * - A new segment starts only on a `word` item whose (normalized)
 *   speaker differs from the current segment's. Punctuation never
 *   starts a segment or changes the current speaker: Speechmatics gives
 *   punctuation no speaker of its own, so it is attributed to the
 *   nearest preceding word's speaker.
 * - Punctuation joins the running text per its documented `attaches_to`
 *   direction (see `SpeechmaticsResultItem`); `previous`/`both` attach
 *   with no leading space, `next` additionally forces the *following*
 *   word to attach with no leading space, and `none` (or a missing
 *   field, for robustness against an undocumented gap) is treated as a
 *   normally-spaced standalone token. This spacing algorithm is this
 *   adapter's own interpretation of the four documented values — the
 *   docs define the values, not a worked spacing example for all of
 *   them.
 * - A segment's `confidence` is the mean of its words' confidences
 *   (punctuation confidence is not counted). Speechmatics documents
 *   confidence only per word, not per segment, so this average is this
 *   adapter's own approximation, not a provider-reported value.
 *
 * `diarize: false` forces every segment's `speaker` to `null`, matching
 * the domain rule that `null` means "no diarization" rather than trying
 * to interpret whatever Speechmatics puts in `alternatives[].speaker`
 * (`"UU"` when diarization was off).
 */
export function groupSpeechmaticsResultsIntoSegments(
  results: readonly SpeechmaticsResultItem[],
  diarize: boolean,
): TranscriptSegment[] {
  const speakers = resolveSpeakers(results, diarize);
  const segments: TranscriptSegment[] = [];
  let current: SegmentBuilder | null = null;
  let noLeadingSpace = false;

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    if (!item) {
      continue;
    }

    const alternative = item.alternatives[0];
    const content = alternative?.content ?? "";
    const startMs = Math.round(item.start_time * 1000);
    const endMs = Math.round(item.end_time * 1000);
    const speaker = speakers[index] ?? null;

    const startsNewSegment =
      item.type === "word" && (current === null || current.speaker !== speaker);

    if (startsNewSegment) {
      if (current !== null) {
        segments.push(finalizeSegment(current));
      }
      current = {
        startMs,
        endMs,
        speaker,
        text: content,
        confidenceSum: alternative?.confidence ?? 0,
        confidenceCount: alternative ? 1 : 0,
      };
      noLeadingSpace = false;
      continue;
    }

    if (current === null) {
      // Punctuation before any word. Not expected in practice, but kept
      // as the start of its own segment rather than silently dropped.
      current = { startMs, endMs, speaker, text: content, confidenceSum: 0, confidenceCount: 0 };
      continue;
    }

    if (item.type === "word") {
      current.text += noLeadingSpace ? content : ` ${content}`;
      if (alternative) {
        current.confidenceSum += alternative.confidence;
        current.confidenceCount += 1;
      }
      noLeadingSpace = false;
    } else {
      const attachesTo = item.attaches_to ?? "none";
      current.text += attachesTo === "previous" || attachesTo === "both" ? content : ` ${content}`;
      noLeadingSpace = attachesTo === "both" || attachesTo === "next";
    }
    current.endMs = endMs;
  }

  if (current !== null) {
    segments.push(finalizeSegment(current));
  }

  return segments;
}

function resolveSpeakers(
  results: readonly SpeechmaticsResultItem[],
  diarize: boolean,
): Array<string | null> {
  if (!diarize) {
    return results.map(() => null);
  }

  const rawWordSpeakers = results.map((item) =>
    item.type === "word" ? (item.alternatives[0]?.speaker ?? null) : null,
  );
  const normalized = normalizeSpeakerLabels(rawWordSpeakers);

  // Punctuation carries no speaker of its own; attribute it to the
  // nearest preceding word's (already normalized) speaker so it joins
  // that word's segment instead of starting a spurious new one.
  let lastSpeaker: string | null = null;
  return results.map((item, index) => {
    if (item.type === "word") {
      lastSpeaker = normalized[index] ?? null;
    }
    return lastSpeaker;
  });
}

function finalizeSegment(builder: SegmentBuilder): TranscriptSegment {
  return {
    startMs: builder.startMs,
    endMs: builder.endMs,
    speaker: builder.speaker,
    text: builder.text,
    confidence:
      builder.confidenceCount > 0 ? builder.confidenceSum / builder.confidenceCount : undefined,
  };
}
