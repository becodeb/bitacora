/**
 * Claude-backed `RollupSummarizer`: one plain (no tools) Haiku call that
 * turns a day's gathered content into a short Rioplatense Spanish diary
 * summary. No tool loop and no structured-output schema — unlike
 * `memory/claude-judge.ts` this is free text for a human to read, not a
 * decision the server code branches on — so the response's own `text`
 * blocks are the whole result.
 *
 * Docs relied on (bundled claude-api skill, read 2026-10-22, same as
 * `agent/claude-client.ts`): `thinking: { type: "adaptive" }` for Haiku
 * 5.5 (no `budget_tokens`), `output_config: { effort }`, check
 * `stop_reason` before trusting the response.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentUsage } from "../agent/types.js";
import type { RollupSummarizeParams, RollupSummarizeResult, RollupSummarizer } from "./types.js";

const ROLLUP_MODEL = "claude-haiku-5-5";
const ROLLUP_MAX_TOKENS = 1_024;

function buildSystemPrompt(): string {
  return [
    "Sos Bitacora, un asistente que le escribe el diario íntimo a su dueño.",
    "Te paso todo lo que la persona escribió, dijo y charló durante un día. Escribí un resumen breve,",
    "en español rioplatense (voseo), en un tono cercano, como una entrada de diario.",
    "Cubrí, solo si hay contenido para eso: qué pasó en el día, qué decisiones tomó,",
    "cosas que conviene recordar más adelante, y cosas que quedaron pendientes.",
    "No inventes nada que no esté en el contenido. Si una categoría no tiene nada, omitila sin más.",
    "Si el contenido dice que fue truncado o es una muestra parcial del día, no lo menciones:",
    "escribí el resumen igual, con lo que tenés.",
  ].join("\n");
}

export interface ClaudeRollupSummarizerOptions {
  apiKey: string;
  client?: Anthropic;
}

function toAgentUsage(usage: Anthropic.Usage): AgentUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
  };
}

export function createClaudeRollupSummarizer(
  options: ClaudeRollupSummarizerOptions,
): RollupSummarizer {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function summarize(params: RollupSummarizeParams): Promise<RollupSummarizeResult> {
    const system = buildSystemPrompt();
    const userMessage = `Fecha: ${params.dateLabel}\n\nContenido del día:\n${params.content}`;
    const requestJson = { system, model: ROLLUP_MODEL, message: userMessage };

    const response = await client.messages.create({
      model: ROLLUP_MODEL,
      max_tokens: ROLLUP_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const usage = toAgentUsage(response.usage);

    if (response.stop_reason === "refusal") {
      console.error(`daily rollup: Claude refused for ${params.dateLabel}`);
      return { summary: null, usage, requestJson };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return { summary: text.length > 0 ? text : null, usage, requestJson };
  }

  return { summarize };
}
