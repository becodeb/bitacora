/**
 * Hybrid search over entries, memories and topics: three independent
 * rankers per scope (Spanish FTS, vector cosine, trigram), fused with
 * Reciprocal Rank Fusion (see `rrf.ts`), then filtered by a relevance
 * threshold so only genuinely relevant hits become "hints" for T06.
 *
 * Why a separate threshold from the fused RRF score: RRF only tells you
 * *relative* order among the candidates this query happened to surface
 * — it has no sense of *absolute* relevance, so the top hit for a query
 * with no good matches at all still gets some fused score. The
 * threshold below is instead defined on signals that are independently
 * interpretable regardless of query: a lexical match actually occurred
 * (FTS/trigram), or the embeddings are close enough in direction to
 * call "related" (vector cosine similarity). `findHints` passes a hit
 * when ANY of those signals clears its bar — see `RELEVANCE_THRESHOLDS`.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DEFAULT_RRF_K, type RankedHit, reciprocalRankFusion } from "./rrf.js";
import type {
  HybridSearchDeps,
  HybridSearchHit,
  HybridSearchParams,
  RankerSignal,
  SearchScope,
} from "./types.js";

export const RELEVANCE_THRESHOLDS = {
  /**
   * Cosine similarity (`1 - cosine distance`) from Voyage embeddings,
   * in [-1, 1] but in practice [0, 1] for short natural-language text.
   * 0.75 is a conservative cut: Voyage's own retrieval guidance and
   * common RAG practice treat similarity below roughly 0.7-0.75 as
   * "topically adjacent" rather than "the same thing", and false
   * positives are worse here than false negatives — a wrong hint
   * confuses Haiku 5.5's tool choice, while a missed hint just means
   * Haiku has to search explicitly, which it can already do (per
   * `odd/tasks/mvp.md`, "Memory design" step 3).
   */
  vectorSimilarityMin: 0.75,
  /**
   * `pg_trgm` similarity in [0, 1]. 0.3 is Postgres's own default
   * `pg_trgm.similarity_threshold` (the cut the `%` operator already
   * applies), left unchanged rather than picking a different number —
   * the trigram queries below use `%` itself, so this constant and the
   * SQL filter are, by construction, always in agreement.
   */
  trigramSimilarityMin: 0.3,
} as const;

const DEFAULT_LIMIT = 10;

/**
 * Candidates fetched per ranker, ahead of fusion: more than the final
 * `limit` so an item one ranker ranks low (or misses) but another ranks
 * highly is not discarded before RRF ever sees it.
 */
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATE_LIMIT = 20;

function candidateLimit(limit: number): number {
  return Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATE_LIMIT);
}

interface RawCandidate {
  id: string;
  score: number;
  sourceEntryId?: string;
}

/** `'[0.1,0.2,...]'::vector` — pgvector's text input format. Built only from embedder output (finite numbers), never from user input, so no injection concern despite the string interpolation. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

interface ScopeRankers {
  fts(db: NodePgDatabase, query: string, limit: number): Promise<RawCandidate[]>;
  trigram(db: NodePgDatabase, query: string, limit: number): Promise<RawCandidate[]>;
  vector(db: NodePgDatabase, vectorLiteral: string, limit: number): Promise<RawCandidate[]>;
}

const entriesRankers: ScopeRankers = {
  async fts(db, query, limit) {
    const result = await db.execute(sql`
      select id, ts_rank_cd(search_vector, websearch_to_tsquery('spanish', ${query})) as score
      from entries
      where search_vector @@ websearch_to_tsquery('spanish', ${query})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, query, limit) {
    const result = await db.execute(sql`
      select id, similarity(coalesce(text_body, '') || ' ' || coalesce(derived_text, ''), ${query}) as score
      from entries
      where (coalesce(text_body, '') || ' ' || coalesce(derived_text, '')) % ${query}
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async vector(db, vectorLiteral, limit) {
    const result = await db.execute(sql`
      select id, 1 - (embedding <=> ${vectorLiteral}::vector) as score
      from entries
      where embedding is not null
      order by embedding <=> ${vectorLiteral}::vector asc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
};

const memoriesRankers: ScopeRankers = {
  async fts(db, query, limit) {
    const result = await db.execute(sql`
      select id, source_entry_id as "sourceEntryId", ts_rank_cd(search_vector, websearch_to_tsquery('spanish', ${query})) as score
      from memories
      where valid_to is null and search_vector @@ websearch_to_tsquery('spanish', ${query})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, query, limit) {
    const result = await db.execute(sql`
      select id, source_entry_id as "sourceEntryId", similarity(content, ${query}) as score
      from memories
      where valid_to is null and content % ${query}
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async vector(db, vectorLiteral, limit) {
    const result = await db.execute(sql`
      select id, source_entry_id as "sourceEntryId", 1 - (embedding <=> ${vectorLiteral}::vector) as score
      from memories
      where valid_to is null and embedding is not null
      order by embedding <=> ${vectorLiteral}::vector asc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
};

const topicsRankers: ScopeRankers = {
  async fts(db, query, limit) {
    const result = await db.execute(sql`
      select id, ts_rank_cd(search_vector, websearch_to_tsquery('spanish', ${query})) as score
      from topics
      where search_vector @@ websearch_to_tsquery('spanish', ${query})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, query, limit) {
    const result = await db.execute(sql`
      select id, similarity(coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(summary, ''), ${query}) as score
      from topics
      where (coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(summary, '')) % ${query}
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async vector(db, vectorLiteral, limit) {
    const result = await db.execute(sql`
      select id, 1 - (embedding <=> ${vectorLiteral}::vector) as score
      from topics
      where embedding is not null
      order by embedding <=> ${vectorLiteral}::vector asc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
};

const rankersByScope: Record<SearchScope, ScopeRankers> = {
  entries: entriesRankers,
  memories: memoriesRankers,
  topics: topicsRankers,
};

function toRankedHits(rows: RawCandidate[]): RankedHit[] {
  return rows.map((row, index) => ({ id: row.id, rank: index + 1 }));
}

interface MergedCandidate {
  id: string;
  sourceEntryId?: string;
  fts?: { rank: number; score: number };
  vector?: { rank: number; score: number };
  trigram?: { rank: number; score: number };
}

function mergeCandidates(
  ftsRows: RawCandidate[],
  vectorRows: RawCandidate[],
  trigramRows: RawCandidate[],
): Map<string, MergedCandidate> {
  const merged = new Map<string, MergedCandidate>();

  const apply = (rows: RawCandidate[], key: "fts" | "vector" | "trigram") => {
    rows.forEach((row, index) => {
      const existing = merged.get(row.id) ?? { id: row.id, sourceEntryId: row.sourceEntryId };
      existing.sourceEntryId ??= row.sourceEntryId;
      existing[key] = { rank: index + 1, score: row.score };
      merged.set(row.id, existing);
    });
  };

  apply(ftsRows, "fts");
  apply(vectorRows, "vector");
  apply(trigramRows, "trigram");
  return merged;
}

/**
 * Builds one hit's signals. `fts` and `trigram` are "matched" simply by
 * being present — their SQL already filtered to genuine matches (`@@`
 * and `%` respectively). `vector` is different: the vector ranker above
 * deliberately does NOT filter by similarity in SQL (it returns the
 * nearest N candidates regardless of how dissimilar they are, so an
 * unrelated query still gets *some* ranked list to fuse), so "matched"
 * here additionally requires clearing `vectorSimilarityMin`.
 */
function buildHit(
  scope: SearchScope,
  candidate: MergedCandidate,
  fusedScore: number,
): HybridSearchHit {
  const fts: RankerSignal = candidate.fts
    ? { matched: true, rank: candidate.fts.rank, score: candidate.fts.score }
    : { matched: false };
  const trigram: RankerSignal = candidate.trigram
    ? { matched: true, rank: candidate.trigram.rank, score: candidate.trigram.score }
    : { matched: false };
  const vector: RankerSignal = candidate.vector
    ? {
        matched: candidate.vector.score >= RELEVANCE_THRESHOLDS.vectorSimilarityMin,
        rank: candidate.vector.rank,
        score: candidate.vector.score,
      }
    : { matched: false };

  return {
    scope,
    id: candidate.id,
    sourceEntryId: scope === "entries" ? candidate.id : candidate.sourceEntryId,
    fusedScore,
    signals: { fts, vector, trigram },
    passesThreshold: fts.matched || vector.matched || trigram.matched,
  };
}

async function searchScope(
  deps: HybridSearchDeps,
  scope: SearchScope,
  query: string,
  queryVectorLiteral: string | null,
  limit: number,
  rrfK: number,
): Promise<HybridSearchHit[]> {
  const rankers = rankersByScope[scope];
  const perRankerLimit = candidateLimit(limit);

  const [ftsRows, trigramRows, vectorRows] = await Promise.all([
    rankers.fts(deps.db, query, perRankerLimit),
    rankers.trigram(deps.db, query, perRankerLimit),
    queryVectorLiteral
      ? rankers.vector(deps.db, queryVectorLiteral, perRankerLimit)
      : Promise.resolve<RawCandidate[]>([]),
  ]);

  const merged = mergeCandidates(ftsRows, vectorRows, trigramRows);
  const fused = reciprocalRankFusion(
    [toRankedHits(ftsRows), toRankedHits(vectorRows), toRankedHits(trigramRows)],
    rrfK,
  );

  const hits = [...merged.values()].map((candidate) =>
    buildHit(scope, candidate, fused.get(candidate.id) ?? 0),
  );
  hits.sort((a, b) => b.fusedScore - a.fusedScore);
  return hits.slice(0, limit);
}

/**
 * Embeds the query for the vector ranker. Returns `null` — instead of
 * throwing — when the embedder itself fails (e.g. Voyage is down or
 * rate-limited), so `hybridSearch` can degrade to its lexical rankers
 * (FTS + trigram) rather than failing the whole search. The same
 * degradation covers a query that happens to embed fine but whose
 * candidates simply have no embedding yet: `searchScope`'s SQL already
 * filters `embedding is not null`, so those rows are just absent from
 * the vector ranker's results, with no special-casing needed here.
 */
async function embedQuery(deps: HybridSearchDeps, query: string): Promise<string | null> {
  try {
    const [vector] = await deps.embedder.embed([query], "query");
    return vector ? toVectorLiteral(vector) : null;
  } catch (error) {
    console.error(
      "hybrid search: query embedding failed, degrading to lexical-only ranking:",
      error,
    );
    return null;
  }
}

export function createHybridSearch(deps: HybridSearchDeps) {
  async function hybridSearch(params: HybridSearchParams): Promise<HybridSearchHit[]> {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const rrfK = params.rrfK ?? DEFAULT_RRF_K;
    const queryVectorLiteral = await embedQuery(deps, params.query);

    const perScope = await Promise.all(
      params.scopes.map((scope) =>
        searchScope(deps, scope, params.query, queryVectorLiteral, limit, rrfK),
      ),
    );

    return perScope.flat();
  }

  /**
   * Relevance-filtered hints for T06: only hits where `passesThreshold`
   * is true, across all three scopes by default, sorted best-first.
   * Possibly empty — an empty array is the expected result for a query
   * with nothing genuinely relevant, not an error.
   */
  async function findHints(
    query: string,
    opts: { scopes?: SearchScope[]; limit?: number; rrfK?: number } = {},
  ): Promise<HybridSearchHit[]> {
    const scopes = opts.scopes ?? (["memories", "topics", "entries"] satisfies SearchScope[]);
    const hits = await hybridSearch({ query, scopes, limit: opts.limit, rrfK: opts.rrfK });
    return hits.filter((hit) => hit.passesThreshold).sort((a, b) => b.fusedScore - a.fusedScore);
  }

  return { hybridSearch, findHints };
}
