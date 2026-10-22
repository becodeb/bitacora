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
  // Groq transcribes voice notes (T04's pg-boss worker runs in this same
  // process), so it is required even though no HTTP route reads it
  // directly.
  GROQ_API_KEY: z.string().trim().min(1, "GROQ_API_KEY is required"),
  // Voyage AI, used to embed entries/memories/topics and search queries
  // (T05). Required for the same reason as GROQ_API_KEY: the embed
  // worker runs in this same process.
  VOYAGE_API_KEY: z.string().trim().min(1, "VOYAGE_API_KEY is required"),
  // Anthropic, used by the agent turn (T06: the Haiku 5.5 tool loop and
  // the memory judge). Required for the same reason as GROQ_API_KEY/
  // VOYAGE_API_KEY: `POST /v1/chat` runs in this same process.
  ANTHROPIC_API_KEY: z.string().trim().min(1, "ANTHROPIC_API_KEY is required"),
  // How much reasoning effort Haiku 5.5 spends per agent-turn call (see
  // `agent/claude-client.ts`'s `output_config.effort`). Defaults to the
  // cheapest tier; raise it only if turn quality needs it.
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  // Directory where attachment files (photos, voice notes) are stored.
  // Relative paths resolve against the process's current working
  // directory. Gitignored; never committed.
  DATA_DIR: z.string().trim().min(1).default("./data"),
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
