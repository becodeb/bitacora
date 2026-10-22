/**
 * Reciprocal Rank Fusion (RRF): combines several ranked lists into one
 * fused ranking using only each list's rank order, not its raw scores.
 * This matters here because the three rankers' raw scores live on
 * incomparable scales — `ts_rank_cd` (FTS), cosine similarity (vector),
 * and `pg_trgm` similarity (trigram) — so averaging or summing them
 * directly would let whichever scale happens to produce bigger numbers
 * dominate. RRF sidesteps that by only ever asking "how high did each
 * ranker place this item", which is comparable across rankers by
 * construction.
 */

export interface RankedHit {
  id: string;
  /** 1-based rank: 1 is the best. */
  rank: number;
}

/**
 * The paper's (Cormack, Clarke & Buettcher, 2009) smoothing constant,
 * also the default used by Elasticsearch and Weaviate's RRF
 * implementations. It dampens the gap between rank 1 and rank 10: with
 * k=60, rank 1 contributes 1/61 and rank 10 contributes 1/70 — a mild
 * slope, so an item that one ranker ranks highly is not automatically
 * crushed by another ranker placing it merely "pretty high" rather than
 * first.
 */
export const DEFAULT_RRF_K = 60;

/**
 * For each id, sums `1 / (k + rank)` over every ranker that returned it.
 * An id a given ranker never returned contributes 0 for that ranker —
 * it is simply absent from that ranker's list, not penalized beyond
 * that. Ids are returned in no particular order; sort by the resulting
 * score to rank them.
 */
export function reciprocalRankFusion(
  rankerResults: RankedHit[][],
  k: number = DEFAULT_RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const hits of rankerResults) {
    for (const hit of hits) {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + hit.rank));
    }
  }

  return scores;
}
