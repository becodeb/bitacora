import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Embedder } from "../embeddings/types.js";

export type SearchScope = "memories" | "topics" | "entries";

export interface HybridSearchDeps {
  db: NodePgDatabase;
  embedder: Embedder;
}

export interface HybridSearchParams {
  query: string;
  scopes: SearchScope[];
  /** Max fused hits returned per scope. Default 10. */
  limit?: number;
  /** RRF's smoothing constant (see `rrf.ts`). Default 60. */
  rrfK?: number;
}

/** One ranker's verdict on one hit: whether it matched, and where/how strongly. */
export interface RankerSignal {
  matched: boolean;
  /** 1-based rank within that ranker's own result list. Absent when `matched` is false. */
  rank?: number;
  /** ts_rank_cd for FTS, cosine similarity (1 - cosine distance) for vector, pg_trgm similarity for trigram. Absent when `matched` is false. */
  score?: number;
}

export interface HybridSearchHit {
  scope: SearchScope;
  id: string;
  /**
   * The entry this hit cites, for UI citations (T06). Equal to `id` for
   * `scope: "entries"`; the memory's `sourceEntryId` for
   * `scope: "memories"`; `undefined` for `scope: "topics"`, which has no
   * single source entry.
   */
  sourceEntryId?: string;
  /** Reciprocal Rank Fusion score across the three rankers; see `rrf.ts`. Not independently calibrated — use `passesThreshold`, not this score, to decide relevance. */
  fusedScore: number;
  signals: {
    fts: RankerSignal;
    vector: RankerSignal;
    trigram: RankerSignal;
  };
  /** Whether this hit clears the relevance bar in `hybrid-search.ts`'s `RELEVANCE_THRESHOLDS`. `findHints` returns only hits where this is `true`. */
  passesThreshold: boolean;
}
