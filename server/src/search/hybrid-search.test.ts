import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { entries, memories } from "../db/schema.js";
import { createFakeEmbedder } from "../embeddings/test-helpers.js";
import type { Embedder } from "../embeddings/types.js";
import { createHybridSearch } from "./hybrid-search.js";

// Mirrors compose.dev.yml's credentials, same convention as db/schema.test.ts.
const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://bitacora:bitacora@localhost:55432/bitacora";

const db = createDb(DEV_DATABASE_URL);

afterAll(async () => {
  await db.pool.end();
});

/** Same rollback-isolation helper as `db/schema.test.ts`: every test runs inside a transaction that is always rolled back, so no row ever leaks into another test. */
async function withRollback(fn: (tx: typeof db.orm) => Promise<void>): Promise<void> {
  try {
    await db.orm.transaction(async (tx) => {
      await fn(tx as unknown as typeof db.orm);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
}

/** Dimensionality of every embedding column; see `EMBEDDING_DIMENSIONS` in `db/schema.ts`. */
const DIMENSIONS = 1024;

/** A unit vector (norm 1) with every weight on one dimension, so cosine similarity against itself is exactly 1 — used to engineer a vector-only hit below, independent of the shared bag-of-words fake embedder. */
function unitVectorAt(dimension: number): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  vector[dimension] = 1;
  return vector;
}

describe("hybridSearch: FTS ranker", () => {
  it("finds an entry via Spanish full-text search", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Tengo varios gatos en casa." });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      const hits = await search.findHints("gato", { scopes: ["entries"] });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.fts.matched).toBe(true);
      expect(hits[0]?.passesThreshold).toBe(true);
    });
  });
});

describe("hybridSearch: trigram ranker", () => {
  it("finds a misspelled single-word query via word_similarity, with no FTS match", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Análisis" });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // "analsis" (missing one letter) stems to a lexeme that never
      // appears in "Análisis"'s own tsvector, so FTS's `@@` finds no
      // candidate row at all — this hit, if found, must come from
      // word_similarity alone. Measured on the dev DB (2026-10-22):
      // word_similarity('analsis', unaccent(lower('Análisis'))) = 0.545.
      const hits = await search.findHints("analsis", { scopes: ["entries"] });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.fts.matched).toBe(false);
      expect(hits[0]?.signals.trigram.matched).toBe(true);
      expect(hits[0]?.signals.trigram.score).toBeCloseTo(0.545, 2);
      expect(hits[0]?.passesThreshold).toBe(true);
    });
  });

  it("ranks a full natural-language sentence lexically, but neither lexical ranker passes the threshold alone", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Análisis" });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // T06's pre-search query is the owner's whole message. This
      // sentence shares only one lexeme/word with "Análisis"
      // ("análisis" itself) out of five total ("che", "cuando",
      // "rindo", "final", "análisis"), so neither FTS's
      // ftsMinMatchedLexemesCap (2) nor trigram's
      // trigramMinMatchedWordsCap (2) is met — a single shared word is
      // exactly the over-permissive case both caps exist to reject. In
      // production this sentence is the vector ranker's job instead: a
      // real voyage-3.5 similarity check for "cuándo rindo análisis" vs
      // "El examen de Análisis es el martes 12 de noviembre" measured
      // 0.524 (2026-10-22), above vectorSimilarityMin (0.5). Here, with
      // the fake embedder, the hit is still ranked (both rankers'
      // candidate-selection SQL keeps it) but does not pass.
      const hits = await search.hybridSearch({
        query: "che, ¿cuándo rindo el final de análisis?",
        scopes: ["entries"],
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.fts.matched).toBe(false);
      expect(hits[0]?.signals.trigram.matched).toBe(false);
      expect(hits[0]?.signals.trigram.score).toBeCloseTo(1, 5);
      expect(hits[0]?.signals.trigram.matchedCount).toBe(1);
      expect(hits[0]?.passesThreshold).toBe(false);
    });
  });

  it("does not pass the threshold on a single shared word, even at similarity 1.0 ('mañana')", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Mañana llueve." });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // "mañana" is an exact substring (word_similarity 1.0), but
      // "tengo" and "turno" score 0 against "Mañana llueve." (measured
      // on the dev DB, 2026-10-22) — only 1 of 3 trigram-eligible words
      // matches, below trigramMinMatchedWordsCap's min(2, 3) = 2. This
      // is the motivating case: without the cap, any message containing
      // "mañana" would pass against this entry regardless of the rest.
      const hits = await search.findHints("mañana tengo turno", { scopes: ["entries"] });

      expect(hits).toHaveLength(0);
    });
  });

  it("passes the threshold when two distinct words each clear the trigram bar", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({
        kind: "text",
        textBody: "El examen de Análisis es el martes 12 de noviembre.",
      });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // "examen" (exact, 1.0) and "analsis" (typo, 0.545) both clear
      // trigramSimilarityMin (measured on the dev DB, 2026-10-22) — 2
      // of 2 trigram-eligible words, meeting min(2, 2) = 2.
      const hits = await search.findHints("examen analsis", { scopes: ["entries"] });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.trigram.matched).toBe(true);
      expect(hits[0]?.signals.trigram.matchedCount).toBe(2);
      expect(hits[0]?.passesThreshold).toBe(true);
    });
  });
});

describe("hybridSearch: all-stopword message", () => {
  it("returns no FTS hits, without erroring, for a message with no lexemes", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Compra leche y pan." });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // "de la el en" is entirely Spanish stopwords: to_tsvector('spanish', ...)
      // yields zero lexemes, which must not blow up to_tsquery.
      const hits = await search.hybridSearch({ query: "de la el en", scopes: ["entries"] });

      expect(hits.filter((hit) => hit.signals.fts.matched)).toHaveLength(0);
    });
  });
});

describe("hybridSearch: vector ranker", () => {
  it("finds a hit via cosine similarity alone, with no FTS or trigram overlap", async () => {
    await withRollback(async (tx) => {
      const sharedVector = unitVectorAt(42);
      await tx.insert(entries).values({
        kind: "text",
        textBody: "Completely unrelated vocabulary with zero lexical overlap.",
        embedding: sharedVector,
      });

      // A fixed embedder, independent of the shared bag-of-words fake:
      // it always returns the exact same vector as the entry's stored
      // embedding above, regardless of the query text, so the only way
      // this hit can be found is the vector ranker's cosine similarity
      // of 1.0 — the query text itself shares no words or substrings
      // with the stored text at all.
      const fixedVectorEmbedder: Embedder = {
        embed: async (texts) => texts.map(() => sharedVector),
      };
      const search = createHybridSearch({ db: tx, embedder: fixedVectorEmbedder });

      const hits = await search.findHints("una consulta totalmente distinta", {
        scopes: ["entries"],
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.fts.matched).toBe(false);
      expect(hits[0]?.signals.trigram.matched).toBe(false);
      expect(hits[0]?.signals.vector.matched).toBe(true);
      expect(hits[0]?.signals.vector.score).toBeCloseTo(1);
      expect(hits[0]?.passesThreshold).toBe(true);
    });
  });
});

describe("hybridSearch: memories scope", () => {
  it("excludes a superseded memory (valid_to in the past) by default", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "El examen es el martes." })
        .returning({ id: entries.id });
      if (!entry) throw new Error("insert did not return a row");

      await tx.insert(memories).values({
        content: "El examen es el martes.",
        sourceEntryId: entry.id,
        validTo: new Date(),
      });

      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });
      const hits = await search.findHints("examen", { scopes: ["memories"] });

      expect(hits).toHaveLength(0);
    });
  });

  it("reports the citing entry as sourceEntryId, for a currently-valid memory", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "El examen es el martes." })
        .returning({ id: entries.id });
      if (!entry) throw new Error("insert did not return a row");
      await tx
        .insert(memories)
        .values({ content: "El examen es el martes.", sourceEntryId: entry.id });

      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });
      const hits = await search.findHints("examen", { scopes: ["memories"] });

      expect(hits[0]?.sourceEntryId).toBe(entry.id);
    });
  });
});

describe("hybridSearch: entries scope", () => {
  it("reports the entry's own id as sourceEntryId", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "El examen es el martes." })
        .returning({ id: entries.id });
      if (!entry) throw new Error("insert did not return a row");

      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });
      const hits = await search.findHints("examen", { scopes: ["entries"] });

      expect(hits[0]?.sourceEntryId).toBe(entry.id);
    });
  });
});

describe("hybridSearch: relevance threshold", () => {
  it("returns no hints for a query unrelated to anything stored", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Compra leche y pan." });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      const hits = await search.findHints("vuelo a marte en un cohete", { scopes: ["entries"] });

      expect(hits).toHaveLength(0);
    });
  });

  it("does not pass the threshold when the only shared word is a stopword", async () => {
    await withRollback(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({ kind: "text", textBody: "El examen es el martes." })
        .returning({ id: entries.id });
      if (!entry) throw new Error("insert did not return a row");
      await tx
        .insert(memories)
        .values({ content: "El examen es el martes.", sourceEntryId: entry.id });

      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      // Shares only "el" with the memory ("El examen es el martes.") —
      // a Spanish stopword, removed from both sides' tsvectors, and too
      // short (2 chars) for the trigram word list. Every other word
      // ("vos", "armaste", "mesa", "jueves") is unrelated: measured
      // word_similarity against "El examen es el martes." tops out at
      // 0.2 ("mesa"), well under trigramSimilarityMin (0.5).
      const hits = await search.findHints("¿vos armaste la mesa el jueves?", {
        scopes: ["memories"],
      });

      expect(hits).toHaveLength(0);
    });
  });
});

describe("hybridSearch: degradation", () => {
  it("falls back to lexical-only ranking when the embedder throws", async () => {
    await withRollback(async (tx) => {
      await tx.insert(entries).values({ kind: "text", textBody: "Tengo varios gatos en casa." });
      const throwingEmbedder: Embedder = {
        embed: async () => {
          throw new Error("simulated Voyage outage");
        },
      };
      const search = createHybridSearch({ db: tx, embedder: throwingEmbedder });

      const hits = await search.findHints("gato", { scopes: ["entries"] });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.signals.fts.matched).toBe(true);
      expect(hits[0]?.signals.vector.matched).toBe(false);
    });
  });

  it("still returns nothing (not an error) when an item has no embedding yet", async () => {
    await withRollback(async (tx) => {
      // No `embedding` set: the vector ranker's `where embedding is not
      // null` excludes this row entirely, and it has no lexical overlap
      // with the query either.
      await tx.insert(entries).values({ kind: "photo" });
      const search = createHybridSearch({ db: tx, embedder: createFakeEmbedder() });

      const hits = await search.hybridSearch({ query: "gato", scopes: ["entries"] });

      expect(hits).toHaveLength(0);
    });
  });
});
