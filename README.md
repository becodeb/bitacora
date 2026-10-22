# Bitacora

Bitacora is a personal, single-user Android app and server that turns
spoken and written input into memory automatically. The owner talks or
types to an AI to record thoughts, reminders and diary entries, record
in-person conversations on demand, and browse an agenda and a daily
diary built from everything that was captured.

See `odd/tasks/mvp.md` for the full feature plan, architecture decisions
and task breakdown.

## Repo layout

- `server/` — Node.js/TypeScript API (Hono, Drizzle ORM on PostgreSQL).
  Owns the processing pipeline, the memory store, and auth.
- `odd/` — the project's living task and planning documents.

The Android app and its native Kotlin module (later tasks) will live in
their own top-level directories alongside `server/`.

## Running the server in development

All commands run from `server/`.

```bash
cd server
npm install

# Start the dev Postgres (pgvector/pgvector:pg17) in Docker.
npm run db:up

# Copy the env template and fill in a real APP_TOKEN and GROQ_API_KEY
# (the latter is in ~/.credentials/bitacora.env; never commit it).
cp .env.example .env

# Apply database migrations (enables the vector/pg_trgm extensions and
# creates the entries/topics/memories/... tables from T03).
npm run db:migrate

# Run the server with live reload.
npm run dev

# Run the test suite (expects the dev DB from `npm run db:up` to be up).
# The suite never reads or writes the dev database directly: a Vitest
# globalSetup (src/test/global-setup.ts) creates and migrates a
# separate <dev-db-name>_test database on the same Postgres server the
# first time it runs, and every test connects to that one instead. Set
# TEST_DATABASE_URL explicitly to point it somewhere else.
npm test
```

Other useful scripts: `npm run typecheck`, `npm run lint`, `npm run format`,
`npm run build` / `npm start` (compiled production build), and
`npm run db:down` to stop the dev database.

### Ingestion (T04)

`POST /v1/entries` stores text, photo or voice entries and `GET
/v1/entries/:id` reads one back. Photo and voice attachments are
written to disk under `DATA_DIR` (default `./data`, gitignored) before
their DB rows are committed. Voice transcription and photo OCR run
asynchronously afterwards, via a pg-boss worker started in the same
process as the HTTP server (`npm run dev`/`npm start` runs both); OCR is
a placeholder until T07 picks an engine.
