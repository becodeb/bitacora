/**
 * Test-only helpers shared by embedding-dependent test suites (embed job
 * tests, hybrid search tests). Not matched by Vitest's
 * `src/**\/*.test.ts` include pattern, so this file is never itself run
 * as a test — same convention as `ingestion/test-helpers.ts`.
 */
import type { Embedder } from "./types.js";

/** Matches `EMBEDDING_DIMENSIONS` in `db/schema.ts`: every `vector(1024)` column requires exactly this length. */
const EMBEDDING_DIMENSIONS = 1024;

function tokenize(text: string): string[] {
  const withoutAccents = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return withoutAccents.match(/[a-z0-9]+/g) ?? [];
}

/** A small, deterministic string hash (not cryptographic) used only to bucket tokens into a fixed-size vector. */
function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return hash % EMBEDDING_DIMENSIONS;
}

function embedOne(text: string): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token)] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/**
 * A deterministic embedder for tests: a hashed bag-of-words vector,
 * L2-normalized to the same 1,024 dimensions as the real Voyage model so
 * it round-trips through the real `vector(1024)` columns. Two texts that
 * share distinctive words get a high cosine similarity; unrelated texts
 * get a low one — enough to exercise vector ranking in
 * `search/hybrid-search.test.ts` without any network call. Accents are
 * stripped before tokenizing (matching the kind of normalization a real
 * embedder would do implicitly), so "análisis" and "analisis" hash to
 * the same token. Ignores `inputType`: unlike Voyage, this fake does not
 * distinguish "query" vs "document" prompts.
 */
export function createFakeEmbedder(): Embedder {
  return {
    embed: async (texts) => texts.map(embedOne),
  };
}
