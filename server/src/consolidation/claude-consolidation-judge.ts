/**
 * Claude-backed `ConsolidationJudge`: a small, cheap Haiku call per
 * candidate pair, structured via a single tool
 * (`tool_choice: "auto"`, never forced — same reasoning as
 * `memory/claude-judge.ts` and `odd/tasks/mvp.md`). A missing/invalid
 * tool call, a refusal, or an API error all fall back to `keep_both`:
 * the one decision that loses no data if it is wrong (a real duplicate
 * just survives to the next nightly run), unlike `merge` or a supersede
 * made confidently on bad judge output.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentUsage } from "../agent/types.js";
import type {
  ConsolidationCandidate,
  ConsolidationDecision,
  ConsolidationDecisionResult,
  ConsolidationJudge,
} from "./types.js";

const JUDGE_MODEL = "claude-haiku-5-5";
const JUDGE_MAX_TOKENS = 1_024;

const decisionInputSchema = z.object({
  action: z.enum(["merge", "keep_both", "a_supersedes_b", "b_supersedes_a"]),
  merged_content: z.string().trim().min(1).optional(),
});

const RECORD_DECISION_TOOL: Anthropic.Tool = {
  name: "record_consolidation_decision",
  description:
    "Record the dedup decision for this pair of memories (A and B): 'merge' if they are about the " +
    "same fact and should become one combined memory (set merged_content to the combined text), " +
    "'a_supersedes_b' if A is a newer/more correct version of the same fact as B, " +
    "'b_supersedes_a' if B is the newer/more correct one, " +
    "or 'keep_both' if they are related but distinct facts that should not be merged.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["merge", "keep_both", "a_supersedes_b", "b_supersedes_a"],
      },
      merged_content: {
        type: "string",
        description:
          "Required when action is 'merge': the single combined fact, replacing both A and B.",
      },
    },
    required: ["action"],
  },
};

function buildSystemPrompt(): string {
  return [
    "You decide whether two memories about the same person are duplicates that should be merged,",
    "one superseding the other, or genuinely distinct facts that should both stay.",
    "Always call the record_consolidation_decision tool exactly once with your decision.",
    "- merge: A and B say the same thing (maybe with different wording or detail) and belong as one memory.",
    "- a_supersedes_b / b_supersedes_a: one is a newer or corrected version of the exact same fact as the other.",
    "- keep_both: A and B are related but are actually different facts; do not lose either one.",
    "When in doubt between merge and keep_both, prefer keep_both — losing a distinct fact is worse than",
    "one small remaining duplicate.",
  ].join("\n");
}

function buildUserPrompt(candidate: ConsolidationCandidate): string {
  return [
    `Memory A (id=${candidate.idA}): "${candidate.contentA}"`,
    `Memory B (id=${candidate.idB}): "${candidate.contentB}"`,
    "",
    `Vector similarity: ${candidate.vectorSimilarity?.toFixed(3) ?? "(unavailable)"}`,
    `Text similarity: ${candidate.trigramSimilarity.toFixed(3)}`,
  ].join("\n");
}

export interface ClaudeConsolidationJudgeOptions {
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

const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0 };

export function createClaudeConsolidationJudge(
  options: ClaudeConsolidationJudgeOptions,
): ConsolidationJudge {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function decide(candidate: ConsolidationCandidate): Promise<ConsolidationDecisionResult> {
    const system = buildSystemPrompt();
    const userMessage = buildUserPrompt(candidate);
    const requestJson = { system, tools: [RECORD_DECISION_TOOL.name], message: userMessage };
    const fallback = (
      reason: string,
      usage: AgentUsage = EMPTY_USAGE,
    ): ConsolidationDecisionResult => {
      console.error(`consolidation judge: ${reason}, defaulting to keep_both`);
      return { decision: { action: "keep_both" }, usage, requestJson };
    };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        system,
        tools: [RECORD_DECISION_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (error) {
      return fallback(`Claude call failed (${String(error)})`);
    }

    const usage = toAgentUsage(response.usage);

    if (response.stop_reason === "refusal") {
      return fallback("Claude refused", usage);
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === "record_consolidation_decision",
    );
    if (!toolUse) {
      return fallback("no record_consolidation_decision tool call", usage);
    }

    const parsed = decisionInputSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return fallback(`tool input failed validation (${parsed.error.message})`, usage);
    }

    if (parsed.data.action === "merge") {
      if (!parsed.data.merged_content) {
        return fallback("merge with no merged_content", usage);
      }
      const decision: ConsolidationDecision = {
        action: "merge",
        mergedContent: parsed.data.merged_content,
      };
      return { decision, usage, requestJson };
    }

    return { decision: { action: parsed.data.action }, usage, requestJson };
  }

  return { decide };
}
