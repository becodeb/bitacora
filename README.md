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

# Copy the env template and fill in a real APP_TOKEN.
cp .env.example .env

# Apply database migrations (enables the vector/pg_trgm extensions and
# creates the entries/topics/memories/... tables from T03).
npm run db:migrate

# Run the server with live reload.
npm run dev

# Run the test suite (expects the dev DB from `npm run db:up` to be up).
npm test
```

Other useful scripts: `npm run typecheck`, `npm run lint`, `npm run format`,
`npm run build` / `npm start` (compiled production build), and
`npm run db:down` to stop the dev database.
