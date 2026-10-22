import { z } from "zod";

/**
 * Server environment schema.
 *
 * Validated once at startup (see `index.ts`) so a missing or malformed
 * value fails fast with a readable message instead of surfacing later as
 * an obscure runtime error.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  APP_TOKEN: z.string().trim().min(16, "APP_TOKEN must be at least 16 characters long"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Parse and validate the server configuration from an environment-like
 * object (defaults to `process.env`). Throws a single `Error` whose
 * message lists every invalid field, so callers can fail fast with one
 * clear report instead of a stack trace per field.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${issues}`);
  }

  return result.data;
}
