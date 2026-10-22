import { describe, expect, it } from "vitest";
import {
  groupSpeechmaticsResultsIntoSegments,
  type SpeechmaticsResultItem,
} from "./speechmatics-segments.js";

function word(
  content: string,
  start: number,
  end: number,
  confidence: number,
  speaker?: string,
): SpeechmaticsResultItem {
  return {
    type: "word",
    start_time: start,
    end_time: end,
    alternatives: [{ content, confidence, speaker }],
  };
}

function punctuation(
  content: string,
  time: number,
  attachesTo: "previous" | "next" | "both" | "none",
): SpeechmaticsResultItem {
  return {
    type: "punctuation",
    start_time: time,
    end_time: time,
    alternatives: [{ content, confidence: 1 }],
    attaches_to: attachesTo,
  };
}

describe("groupSpeechmaticsResultsIntoSegments", () => {
  it("joins 'previous'-attached punctuation with no leading space", () => {
    const results = [
      word("Hola", 0, 0.3, 0.9, "S1"),
      punctuation(",", 0.3, "previous"),
      word("Juan", 0.4, 0.6, 0.8, "S1"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("Hola, Juan");
  });

  it("joins 'both'-attached punctuation with no space on either side", () => {
    const results = [
      word("quince", 0, 0.3, 0.9, "S1"),
      punctuation("-", 0.3, "both"),
      word("veinte", 0.4, 0.6, 0.8, "S1"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments[0]?.text).toBe("quince-veinte");
  });

  it("keeps a normal leading space before a 'next'-attached token, then sticks the following word to it", () => {
    const results = [
      word("cuesta", 0, 0.3, 0.9, "S1"),
      punctuation("$", 0.3, "next"),
      word("100", 0.4, 0.6, 0.8, "S1"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments[0]?.text).toBe("cuesta $100");
  });

  it("spaces a 'none'-attached token normally on both sides", () => {
    const results = [
      word("son", 0, 0.3, 0.9, "S1"),
      punctuation("//", 0.3, "none"),
      word("dos", 0.4, 0.6, 0.8, "S1"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments[0]?.text).toBe("son // dos");
  });

  it("starts a new segment only when the speaker changes on a word, never on punctuation", () => {
    const results = [
      word("Hola", 0, 0.3, 1, "S1"),
      punctuation(",", 0.3, "previous"),
      word("che", 0.8, 1.0, 1, "S2"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments.map((s) => s.text)).toEqual(["Hola,", "che"]);
    expect(segments.map((s) => s.speaker)).toEqual(["S1", "S2"]);
  });

  it("re-normalizes raw speaker labels by order of first appearance, reusing the label on reappearance", () => {
    const results = [
      word("uno", 0, 0.2, 1, "S4"),
      word("dos", 0.3, 0.5, 1, "S2"),
      word("tres", 0.6, 0.8, 1, "S4"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments.map((s) => s.speaker)).toEqual(["S1", "S2", "S1"]);
  });

  it("forces every speaker to null when diarize is false, regardless of raw speaker labels", () => {
    const results = [word("uno", 0, 0.2, 1, "S1"), word("dos", 0.3, 0.5, 1, "S2")];

    const segments = groupSpeechmaticsResultsIntoSegments(results, false);

    expect(segments.every((s) => s.speaker === null)).toBe(true);
  });

  it("uses millisecond-rounded start/end times from the first and last item of the segment", () => {
    const results = [word("uno", 0.161, 0.48, 1, "S1"), punctuation(".", 0.481, "previous")];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments[0]).toMatchObject({ startMs: 161, endMs: 481 });
  });

  it("averages word confidences within a segment and excludes punctuation from the average", () => {
    const results = [
      word("uno", 0, 0.2, 0.8, "S1"),
      word("dos", 0.3, 0.5, 1.0, "S1"),
      punctuation(".", 0.5, "previous"),
    ];

    const segments = groupSpeechmaticsResultsIntoSegments(results, true);

    expect(segments[0]?.confidence).toBeCloseTo(0.9);
  });

  it("returns an empty array for no results", () => {
    expect(groupSpeechmaticsResultsIntoSegments([], true)).toEqual([]);
  });
});
