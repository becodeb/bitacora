import { describe, expect, it } from "vitest";
import { DEFAULT_RRF_K, reciprocalRankFusion } from "./rrf.js";

describe("reciprocalRankFusion", () => {
  it("scores a single ranker's rank-1 hit as 1/(k+1)", () => {
    const scores = reciprocalRankFusion([[{ id: "a", rank: 1 }]], 60);

    expect(scores.get("a")).toBeCloseTo(1 / 61);
  });

  it("sums contributions from every ranker that returned the id", () => {
    const scores = reciprocalRankFusion([[{ id: "a", rank: 1 }], [{ id: "a", rank: 3 }]], 60);

    expect(scores.get("a")).toBeCloseTo(1 / 61 + 1 / 63);
  });

  it("does not add anything for a ranker that never returned the id", () => {
    const scores = reciprocalRankFusion([[{ id: "a", rank: 1 }], [{ id: "b", rank: 1 }]], 60);

    expect(scores.get("a")).toBeCloseTo(1 / 61);
    expect(scores.has("b")).toBe(true);
  });

  it("ranks an item agreed upon by two rankers above one only one ranker likes, even at rank 1", () => {
    const scores = reciprocalRankFusion([
      [
        { id: "agreed", rank: 2 },
        { id: "lone-winner", rank: 1 },
      ],
      [{ id: "agreed", rank: 1 }],
    ]);

    const agreedScore = scores.get("agreed") ?? 0;
    const loneScore = scores.get("lone-winner") ?? 0;
    expect(agreedScore).toBeGreaterThan(loneScore);
  });

  it("defaults k to 60", () => {
    const withDefault = reciprocalRankFusion([[{ id: "a", rank: 5 }]]);
    const withExplicit = reciprocalRankFusion([[{ id: "a", rank: 5 }]], DEFAULT_RRF_K);

    expect(withDefault.get("a")).toBe(withExplicit.get("a"));
  });

  it("returns an empty map for no rankers or no hits", () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
    expect(reciprocalRankFusion([[], []]).size).toBe(0);
  });
});
