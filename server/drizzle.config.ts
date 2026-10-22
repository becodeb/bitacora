import { defineConfig } from "drizzle-kit";

try {
  // Loads server/.env when present (Node 24's built-in env file loader).
  // Not an error if it is missing: DATABASE_URL may already be set in
  // the shell, e.g. in CI.
  process.loadEnvFile();
} catch {
  // Intentionally ignored; see comment above.
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required to run drizzle-kit. Copy server/.env.example to server/.env and fill it in.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
