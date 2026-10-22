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
 *
 * T06's pre-search query is the owner's whole message, a sentence —
 * not a keyword — which the FTS and trigram rankers below are built
 * around:
 *
 * - FTS: `websearch_to_tsquery` ANDs every term, so a natural sentence
 *   almost never matches a short memory/topic in full. Instead,
 *   `prepareFtsQuery` extracts the message's own Spanish lexemes and
 *   ORs them into one `to_tsquery('simple', …)`, so any single shared
 *   lexeme makes a row a candidate — then `ftsMinMatchedLexemesCap`
 *   gates the *threshold* decision separately, so ranking stays
 *   permissive while "this counts as a hint" stays conservative.
 * - Trigram: comparing the whole message string against a short
 *   document (`similarity(doc, whole_message)`) dilutes towards zero,
 *   and has no accent folding. Instead, each ranker below scores a
 *   document by the best `word_similarity` of any single query word
 *   (`extractTrigramWords`) against it, with `unaccent` folding both
 *   sides — then, mirroring FTS, `trigramMinMatchedWordsCap` gates the
 *   threshold decision on how many distinct words matched, not just
 *   the best one: `word_similarity` scores an exact substring 1.0, so
 *   without this cap a single shared word (e.g. "mañana" in "mañana
 *   tengo turno") would be exactly as over-permissive as a single
 *   shared FTS lexeme.
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
   * Calibrated on real `voyage-3.5` vectors (query vs document input
   * types) with short Spanish notes on 2026-10-22: related pairs scored
   * 0.52-0.64, including "qué carrera hago" vs "Estudio Ingeniería en
   * Sistemas", which share no words. Unrelated pairs peaked at 0.44.
   * 0.50 sits in that gap. A generic RAG cut of 0.7-0.75 rejected every
   * related pair, which would leave lexical rankers as the only source
   * of hints. Re-calibrate once there is real usage data: a wrong hint
   * costs context, a missed hint means Haiku has to search explicitly.
   */
  vectorSimilarityMin: 0.5,
  /**
   * `word_similarity` (pg_trgm) of one query word against the best-
   * matching substring of the document text, in [0, 1]. Measured on the
   * dev DB on 2026-10-22 with `unaccent`+`lower` on both sides: the
   * motivating typo "analsis" vs "Análisis" scores 0.545, and "analsis"
   * vs an unrelated word ("sistemas") scores 0.125. In a full-sentence
   * query ("che, ¿cuándo rindo el final de análisis?") the shared word
   * "análisis" scores 1.0 (exact substring) while the sentence's other
   * words ("cuando", "rindo", "final") score 0, 0, 0.167 against an
   * unrelated document. 0.5 sits cleanly above every unrelated score
   * observed and below the typo-tolerant match.
   */
  trigramSimilarityMin: 0.5,
  /**
   * An FTS hit must share at least this many distinct lexemes with the
   * query to count as "matched" for the relevance threshold — or all of
   * the query's lexemes, if it has fewer than this. A single shared
   * word is too permissive once the query is a whole sentence rather
   * than a keyword (T06's pre-search query is the owner's whole
   * message): "analsis de sistemas" sharing only "sistemas" with
   * "Estudia Ingeniería en Sistemas" should not alone justify a hint —
   * `trigramSimilarityMin` above is what actually catches cases like
   * that, when the shared word is distinctive enough. All FTS-matched
   * rows are still ranked for RRF regardless of this cap; it only gates
   * the threshold decision (`signals.fts.matched`), not ranking.
   */
  ftsMinMatchedLexemesCap: 2,
  /**
   * The trigram twin of `ftsMinMatchedLexemesCap`, for the same reason:
   * `word_similarity` makes an exact substring score 1.0, so a single
   * shared word is exactly as permissive a trigram match as it is an
   * FTS one — "mañana tengo turno" would otherwise pass against any
   * memory merely containing "mañana", with "tengo"/"turno" never
   * checked. A trigram hit must have at least this many distinct query
   * words (not just the best one) individually clear
   * `trigramSimilarityMin` — or all of the query's trigram-eligible
   * words, if it has fewer than this. Ranking still uses every
   * candidate whose single best word clears `trigramSimilarityMin`
   * (unchanged); this cap only gates the threshold decision
   * (`signals.trigram.matched`).
   */
  trigramMinMatchedWordsCap: 2,
} as const;

/** Query words shorter than this are excluded from the trigram ranker: articles and prepositions are rarely distinctive, and pg_trgm's own similarity degrades for very short strings regardless of meaning. */
const TRIGRAM_MIN_WORD_LENGTH = 4;

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
  /** FTS rows only: how many distinct query lexemes this row's search_vector shares with the query. Used by `buildHit` against `ftsMinMatchedLexemesCap`. */
  matchedLexemes?: number;
  /** Trigram rows only: how many distinct query words individually clear `trigramSimilarityMin` against this row's text. Used by `buildHit` against `trigramMinMatchedWordsCap`. */
  matchedWords?: number;
}

/** `'[0.1,0.2,...]'::vector` — pgvector's text input format. Built only from embedder output (finite numbers), never from user input, so no injection concern despite the string interpolation. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Postgres's `{"a","b"}` array-literal text format. Used instead of
 * interpolating a JS array directly into `sql` — drizzle's `sql`
 * template spreads a JS array into one bound parameter per element
 * (`$2, $3, $4, ...`) rather than binding it as a single array value,
 * which breaks a trailing `::text[]` cast (one element casts a bare
 * scalar; two or more look like a tuple being cast to an array, which
 * Postgres rejects). A single string parameter, cast once, has neither
 * problem. Each element is individually quoted so a lexeme or word
 * containing `"`, `\`, `,` or `{}` cannot corrupt the literal.
 */
function toTextArrayLiteral(values: string[]): string {
  const quoted = values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${quoted.join(",")}}`;
}

/**
 * The query's Spanish-normalized lexemes, prepared once per search and
 * reused across every scope (the normalization does not depend on
 * which table is being searched).
 */
interface FtsPreparation {
  /**
   * The query's lexemes, OR-joined and already `quote_literal`'d by
   * Postgres (see `prepareFtsQuery`), ready to pass as `to_tsquery`'s
   * second argument. Parsed with the `simple` config — not `spanish`
   * again — because the lexemes are already stemmed; re-stemming an
   * already-stemmed form through the Spanish dictionary is unreliable.
   */
  orQueryText: string;
  /** The same lexemes, as a plain array, used to count how many a given row's search_vector actually shares with the query (see `matchedLexemes`). */
  lexemes: string[];
  requiredMatchedLexemes: number;
}

/**
 * Builds `FtsPreparation` from the raw message, or `null` when the
 * message has no lexemes at all — entirely stopwords/punctuation (e.g.
 * "de la el en") — in which case every scope's FTS ranker is skipped
 * entirely rather than being asked to parse an empty `to_tsquery`,
 * which Postgres rejects as a syntax error.
 */
async function prepareFtsQuery(db: NodePgDatabase, query: string): Promise<FtsPreparation | null> {
  const result = await db.execute(sql`
    select
      array_agg(lexeme) as lexemes,
      string_agg(quote_literal(lexeme), ' | ') as or_query
    from unnest(tsvector_to_array(to_tsvector('spanish', ${query}))) as lexeme
  `);
  const row = result.rows[0] as { lexemes: string[] | null; or_query: string | null };

  if (!row.lexemes || row.lexemes.length === 0 || !row.or_query) {
    return null;
  }

  return {
    orQueryText: row.or_query,
    lexemes: row.lexemes,
    requiredMatchedLexemes: Math.min(
      RELEVANCE_THRESHOLDS.ftsMinMatchedLexemesCap,
      row.lexemes.length,
    ),
  };
}

/**
 * Splits the message into unaccented, lowercased words at least
 * `TRIGRAM_MIN_WORD_LENGTH` characters long, for the per-word trigram
 * ranker below. `unaccent` only needs to run on the document side in
 * SQL (see the rankers) because this already strips accents on the
 * query side via Unicode NFD decomposition — the same normalization
 * `unaccent`'s default dictionary applies to Spanish text (e.g. "ñ" →
 * "n"), so both sides end up comparable.
 */
function extractTrigramWords(query: string): string[] {
  const withoutAccents = query.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = withoutAccents.match(/[a-z0-9]+/g) ?? [];
  return words.filter((word) => word.length >= TRIGRAM_MIN_WORD_LENGTH);
}

interface ScopeRankers {
  fts(db: NodePgDatabase, ftsPrep: FtsPreparation, limit: number): Promise<RawCandidate[]>;
  trigram(db: NodePgDatabase, queryWords: string[], limit: number): Promise<RawCandidate[]>;
  vector(db: NodePgDatabase, vectorLiteral: string, limit: number): Promise<RawCandidate[]>;
}

/**
 * All three trigram rankers below use `cross join lateral` + `group by`
 * over `unnest(queryWords)`, not an index: there is no functional index
 * over "max word_similarity across an arbitrary word list", and with a
 * single owner and small tables (per `odd/tasks/mvp.md`) a sequential
 * scan here is not a performance concern.
 */
const entriesRankers: ScopeRankers = {
  async fts(db, ftsPrep, limit) {
    const result = await db.execute(sql`
      select
        id,
        ts_rank_cd(search_vector, to_tsquery('simple', ${ftsPrep.orQueryText})) as score,
        (
          select count(*) from unnest(tsvector_to_array(search_vector)) as doc_lexeme
          where doc_lexeme = any(${toTextArrayLiteral(ftsPrep.lexemes)}::text[])
        )::int as "matchedLexemes"
      from entries
      where search_vector @@ to_tsquery('simple', ${ftsPrep.orQueryText})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, queryWords, limit) {
    const result = await db.execute(sql`
      select id, max(scored.ws) as score, count(*) filter (where scored.ws >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin})::int as "matchedWords"
      from entries
      cross join lateral (
        select word_similarity(w, unaccent(lower(coalesce(entries.text_body, '') || ' ' || coalesce(entries.derived_text, '')))) as ws
        from unnest(${toTextArrayLiteral(queryWords)}::text[]) as w
      ) scored
      group by entries.id
      having max(scored.ws) >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin}
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
  async fts(db, ftsPrep, limit) {
    const result = await db.execute(sql`
      select
        id,
        source_entry_id as "sourceEntryId",
        ts_rank_cd(search_vector, to_tsquery('simple', ${ftsPrep.orQueryText})) as score,
        (
          select count(*) from unnest(tsvector_to_array(search_vector)) as doc_lexeme
          where doc_lexeme = any(${toTextArrayLiteral(ftsPrep.lexemes)}::text[])
        )::int as "matchedLexemes"
      from memories
      where valid_to is null and search_vector @@ to_tsquery('simple', ${ftsPrep.orQueryText})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, queryWords, limit) {
    const result = await db.execute(sql`
      select memories.id, memories.source_entry_id as "sourceEntryId", max(scored.ws) as score, count(*) filter (where scored.ws >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin})::int as "matchedWords"
      from memories
      cross join lateral (
        select word_similarity(w, unaccent(lower(memories.content))) as ws
        from unnest(${toTextArrayLiteral(queryWords)}::text[]) as w
      ) scored
      where memories.valid_to is null
      group by memories.id
      having max(scored.ws) >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin}
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
  async fts(db, ftsPrep, limit) {
    const result = await db.execute(sql`
      select
        id,
        ts_rank_cd(search_vector, to_tsquery('simple', ${ftsPrep.orQueryText})) as score,
        (
          select count(*) from unnest(tsvector_to_array(search_vector)) as doc_lexeme
          where doc_lexeme = any(${toTextArrayLiteral(ftsPrep.lexemes)}::text[])
        )::int as "matchedLexemes"
      from topics
      where search_vector @@ to_tsquery('simple', ${ftsPrep.orQueryText})
      order by score desc
      limit ${limit}
    `);
    return result.rows as unknown as RawCandidate[];
  },
  async trigram(db, queryWords, limit) {
    const result = await db.execute(sql`
      select id, max(scored.ws) as score, count(*) filter (where scored.ws >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin})::int as "matchedWords"
      from topics
      cross join lateral (
        select word_similarity(w, unaccent(lower(coalesce(topics.name, '') || ' ' || coalesce(topics.description, '') || ' ' || coalesce(topics.summary, '')))) as ws
        from unnest(${toTextArrayLiteral(queryWords)}::text[]) as w
      ) scored
      group by topics.id
      having max(scored.ws) >= ${RELEVANCE_THRESHOLDS.trigramSimilarityMin}
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
  fts?: { rank: number; score: number; matchedLexemes: number };
  vector?: { rank: number; score: number };
  trigram?: { rank: number; score: number; matchedWords: number };
}

function mergeCandidates(
  ftsRows: RawCandidate[],
  vectorRows: RawCandidate[],
  trigramRows: RawCandidate[],
): Map<string, MergedCandidate> {
  const merged = new Map<string, MergedCandidate>();
  const get = (row: RawCandidate) =>
    merged.get(row.id) ?? { id: row.id, sourceEntryId: row.sourceEntryId };

  ftsRows.forEach((row, index) => {
    const existing = get(row);
    existing.sourceEntryId ??= row.sourceEntryId;
    existing.fts = { rank: index + 1, score: row.score, matchedLexemes: row.matchedLexemes ?? 0 };
    merged.set(row.id, existing);
  });
  vectorRows.forEach((row, index) => {
    const existing = get(row);
    existing.sourceEntryId ??= row.sourceEntryId;
    existing.vector = { rank: index + 1, score: row.score };
    merged.set(row.id, existing);
  });
  trigramRows.forEach((row, index) => {
    const existing = get(row);
    existing.sourceEntryId ??= row.sourceEntryId;
    existing.trigram = {
      rank: index + 1,
      score: row.score,
      matchedWords: row.matchedWords ?? 0,
    };
    merged.set(row.id, existing);
  });

  return merged;
}

/**
 * Builds one hit's signals.
 *
 * - `fts` additionally requires `matchedLexemes >= requiredMatchedLexemes`
 *   (see `ftsMinMatchedLexemesCap`): the SQL's `@@` already filtered to
 *   an OR match on at least one lexeme, which alone is too permissive
 *   for a whole-sentence query.
 * - `trigram` is the same two-tier shape as `fts`, for the same reason:
 *   its SQL already filtered to rows whose single *best* word clears
 *   `trigramSimilarityMin` (ranking stays permissive, like FTS's `@@`),
 *   but "matched" additionally requires `matchedWords >=
 *   requiredMatchedWords` (see `trigramMinMatchedWordsCap`) — otherwise
 *   a single shared word (e.g. "mañana" in "mañana tengo turno") would
 *   pass purely because `word_similarity` scores an exact substring
 *   1.0, exactly the over-permissiveness `ftsMinMatchedLexemesCap`
 *   exists to prevent on the FTS side.
 * - `vector` is different again: the vector ranker deliberately does
 *   NOT filter by similarity in SQL (it returns the nearest N
 *   candidates regardless of how dissimilar they are, so an unrelated
 *   query still gets *some* ranked list to fuse), so "matched" here
 *   requires clearing `vectorSimilarityMin` in application code.
 */
function buildHit(
  scope: SearchScope,
  candidate: MergedCandidate,
  fusedScore: number,
  requiredMatchedLexemes: number,
  requiredMatchedWords: number,
): HybridSearchHit {
  const fts: RankerSignal = candidate.fts
    ? {
        matched: candidate.fts.matchedLexemes >= requiredMatchedLexemes,
        rank: candidate.fts.rank,
        score: candidate.fts.score,
        matchedCount: candidate.fts.matchedLexemes,
      }
    : { matched: false };
  const trigram: RankerSignal = candidate.trigram
    ? {
        matched: candidate.trigram.matchedWords >= requiredMatchedWords,
        rank: candidate.trigram.rank,
        score: candidate.trigram.score,
        matchedCount: candidate.trigram.matchedWords,
      }
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
  ftsPrep: FtsPreparation | null,
  queryWords: string[],
  queryVectorLiteral: string | null,
  limit: number,
  rrfK: number,
): Promise<HybridSearchHit[]> {
  const rankers = rankersByScope[scope];
  const perRankerLimit = candidateLimit(limit);

  const [ftsRows, trigramRows, vectorRows] = await Promise.all([
    ftsPrep ? rankers.fts(deps.db, ftsPrep, perRankerLimit) : Promise.resolve<RawCandidate[]>([]),
    queryWords.length > 0
      ? rankers.trigram(deps.db, queryWords, perRankerLimit)
      : Promise.resolve<RawCandidate[]>([]),
    queryVectorLiteral
      ? rankers.vector(deps.db, queryVectorLiteral, perRankerLimit)
      : Promise.resolve<RawCandidate[]>([]),
  ]);

  const merged = mergeCandidates(ftsRows, vectorRows, trigramRows);
  const fused = reciprocalRankFusion(
    [toRankedHits(ftsRows), toRankedHits(vectorRows), toRankedHits(trigramRows)],
    rrfK,
  );
  const requiredMatchedLexemes = ftsPrep?.requiredMatchedLexemes ?? 0;
  const requiredMatchedWords = Math.min(
    RELEVANCE_THRESHOLDS.trigramMinMatchedWordsCap,
    queryWords.length,
  );

  const hits = [...merged.values()].map((candidate) =>
    buildHit(
      scope,
      candidate,
      fused.get(candidate.id) ?? 0,
      requiredMatchedLexemes,
      requiredMatchedWords,
    ),
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

    // Normalized once per call, not per scope: the query's lexemes and
    // trigram-eligible words do not depend on which table is searched.
    const [ftsPrep, queryVectorLiteral] = await Promise.all([
      prepareFtsQuery(deps.db, params.query),
      embedQuery(deps, params.query),
    ]);
    const queryWords = extractTrigramWords(params.query);

    const perScope = await Promise.all(
      params.scopes.map((scope) =>
        searchScope(deps, scope, ftsPrep, queryWords, queryVectorLiteral, limit, rrfK),
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
