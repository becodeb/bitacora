import { describe, expect, it } from "vitest";
import { normalizeSpeakerLabels } from "./speaker-labels.js";

describe("normalizeSpeakerLabels", () => {
  it("assigns S1, S2, … in order of first appearance, regardless of the raw label", () => {
    expect(normalizeSpeakerLabels(["A", "B", "A", "C"])).toEqual(["S1", "S2", "S1", "S3"]);
  });

  it("re-numbers labels that are already S-prefixed but out of order", () => {
    expect(normalizeSpeakerLabels(["S4", "S2", "S4"])).toEqual(["S1", "S2", "S1"]);
  });

  it("maps null and undefined through as null, without counting them as a speaker", () => {
    expect(normalizeSpeakerLabels(["A", null, "A", undefined, "B"])).toEqual([
      "S1",
      null,
      "S1",
      null,
      "S2",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeSpeakerLabels([])).toEqual([]);
  });
});
