/**
 * Claude-backed `MemoryJudge`: a small, cheap Haiku call that decides
 * ADD / UPDATE / NOOP for one new fact against its most similar live
 * memories (Mem0-style dedup). Kept separate from the main agent loop
 * (`agent/`) because it is a different, narrower call: no streaming, no
 * multi-turn tool loop, one forced decision.
 *
 * Structured decision via a single tool: `tool_choice: "auto"` (never
 * forced — see `odd/tasks/mvp.md` and the agent loop's own choice for
 * the same reasoning), with the system prompt instructing the model to
 * always call `record_decision`. A missing or invalid tool call falls
 * back to `{ action: "noop" }`: duplicating a memory is more fixable
 * later (nightly consolidation, T08) than silently never getting a
 * fact remembered, but a wrong ADD/UPDATE made confidently on bad judge
 * output is the one that is hard to notice without reading context, so
 * the safe default leans conservative.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { JudgeDecision, MemoryJudge, MemoryJudgeParams } from "./types.js";

const JUDGE_MODEL = "claude-haiku-5-5";
const JUDGE_MAX_TOKENS = 512;

const decisionInputSchema = z.object({
  action: z.enum(["add", "update", "noop"]),
  supersedes_id: z.string().uuid().optional(),
});

const RECORD_DECISION_TOOL: Anthropic.Tool = {
  name: "record_decision",
  description:
    "Record the dedup decision for the new fact: 'add' if it is genuinely new, " +
    "'update' if it replaces/corrects one of the candidates (set supersedes_id to " +
    "that candidate's id), or 'noop' if an existing candidate already says the same thing.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "update", "noop"] },
      supersedes_id: {
        type: "string",
        description: "Required when action is 'update': the id of the candidate it replaces.",
      },
    },
    required: ["action"],
  },
};

function buildSystemPrompt(): string {
  return [
    "You decide how a new fact about the owner relates to their existing memories.",
    "Always call the record_decision tool exactly once with your decision.",
    "- add: the fact is genuinely new information, not covered by any candidate.",
    "- update: the fact corrects or replaces one specific candidate (set supersedes_id to its id).",
    "- noop: an existing candidate already states the same fact (no new information).",
    "Candidates are listed with their similarity to the new fact; higher is more similar.",
  ].join("\n");
}

function buildUserPrompt(params: MemoryJudgeParams): string {
  const candidateLines =
    params.candidates.length === 0
      ? "(no similar existing memories)"
      : params.candidates
          .map((c) => `- id=${c.id} similarity=${c.similarity.toFixed(3)}: "${c.content}"`)
          .join("\n");

  return [`New fact: "${params.newContent}"`, "", "Candidates:", candidateLines].join("\n");
}

export interface ClaudeMemoryJudgeOptions {
  apiKey: string;
  client?: Anthropic;
}

export function createClaudeMemoryJudge(options: ClaudeMemoryJudgeOptions): MemoryJudge {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  async function decide(params: MemoryJudgeParams): Promise<JudgeDecision> {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        system: buildSystemPrompt(),
        tools: [RECORD_DECISION_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: buildUserPrompt(params) }],
      });
    } catch (error) {
      console.error("memory judge: Claude call failed, defaulting to noop:", error);
      return { action: "noop" };
    }

    if (response.stop_reason === "refusal") {
      console.error("memory judge: Claude refused, defaulting to noop");
      return { action: "noop" };
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === "record_decision",
    );
    if (!toolUse) {
      console.error("memory judge: no record_decision tool call, defaulting to noop");
      return { action: "noop" };
    }

    const parsed = decisionInputSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      console.error(
        "memory judge: record_decision input failed validation, defaulting to noop:",
        parsed.error.message,
      );
      return { action: "noop" };
    }

    if (parsed.data.action === "update") {
      if (!parsed.data.supersedes_id) {
        console.error("memory judge: update with no supersedes_id, defaulting to noop");
        return { action: "noop" };
      }
      return { action: "update", supersedesId: parsed.data.supersedes_id };
    }

    return { action: parsed.data.action };
  }

  return { decide };
}
