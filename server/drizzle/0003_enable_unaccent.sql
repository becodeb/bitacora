-- Used by the trigram ranker in `search/hybrid-search.ts` for
-- accent-insensitive matching (e.g. "analsis" vs "Análisis").
CREATE EXTENSION IF NOT EXISTS unaccent;
