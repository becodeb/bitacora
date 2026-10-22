/**
 * Claude-backed `TopicSummarizer`: one plain (no tools) Haiku call per
 * stale topic, same shape as `rollup/claude-rollup.ts` (free text, no
 * structured output) but a different prompt — a short description of
 * what is known about a topic, not a diary entry for a day.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentUsage } from "../agent/types.js";
import type { TopicSummarizeParams, TopicSummarizeResult, TopicSummarizer } from "./types.js";

const SUMMARIZER_MODEL = "claude-haiku-5-5";
const SUMMARIZER_MAX_TOKENS = 512;

function buildSystemPrompt(): string {
  return [
    "Sos Bitacora. Te paso el nombre de un tema y las memorias (hechos) que se guardaron bajo ese tema.",
    "Escribí un resumen breve, en español rioplatense, de qué se sabe sobre ese tema.",
    "No repitas los hechos uno por uno: sintetizalos. No inventes nada que no esté en la lista.",
  ].join("\n");
}

export interface ClaudeTopicSummarizerOptions {
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

export function createClaudeTopicSummarizer(
  options: ClaudeTopicSummarizerOptions,
): TopicSummarizer {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function summarize(params: TopicSummarizeParams): Promise<TopicSummarizeResult> {
    const system = buildSystemPrompt();
    const userMessage = [
      `Tema: ${params.topicName}`,
      "",
      "Memorias:",
      ...params.memoryContents.map((content) => `- ${content}`),
    ].join("\n");
    const requestJson = { system, model: SUMMARIZER_MODEL, message: userMessage };

    const response = await client.messages.create({
      model: SUMMARIZER_MODEL,
      max_tokens: SUMMARIZER_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const usage = toAgentUsage(response.usage);

    if (response.stop_reason === "refusal") {
      console.error(`topic summarizer: Claude refused for topic "${params.topicName}"`);
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
