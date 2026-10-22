-- Required by the schema that follows: `vector` for embedding columns and
-- HNSW indexes, `pg_trgm` for typo-tolerant trigram search.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
