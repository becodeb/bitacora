/**
 * Builds the agent turn's request content: the stable, cacheable system
 * prompt (English behaviour instructions — see `odd/tasks/mvp.md`'s T06
 * spec) and the volatile per-turn context block (topic names, hints,
 * current date/time), which is never cached because it changes on every
 * turn.
 */
import type { HybridSearchHit } from "../search/types.js";
import type { RefTracker } from "./refs.js";

const TIMEZONE = "America/Argentina/Buenos_Aires";

/**
 * Stable across every turn (same bytes every time, see
 * `shared/prompt-caching.md`): English instructions for the model's own
 * behaviour, not for what it says to the owner.
 */
export function buildSystemPrompt(): string {
  return [
    "You are Bitacora, a personal assistant that remembers facts about its owner and helps manage their life.",
    "",
    "Behaviour:",
    "- Always answer the owner in Rioplatense Spanish (voseo), regardless of the language of this prompt or of your own reasoning.",
    "- Act on the owner's behalf without asking for confirmation first. Every action you take through a tool is undo-able (the owner can ask to undo the last turn), so prefer acting over asking.",
    "- Ask the owner a clarifying question only when you truly cannot resolve something on your own (e.g. an ambiguous reference with no good default).",
    "- Never invent facts about the owner. Only state something as fact if it came from a hint, a search result, or the owner's own message in this conversation.",
    "- Cite every fact you use that came from a hint or a search result, with its reference number in square brackets, e.g. [#1]. Do not cite facts that came from the owner's current message.",
    "- Use the open_topic and search tools to look up information before answering, when the hints given are not enough.",
    "- Use the remember tool to save new facts the owner tells you about themselves. Use update_rule to save structured preferences (formats, lead times, etc).",
    "- If the owner asks to undo your last action, use the undo tool.",
  ].join("\n");
}

export interface PromptContextHint {
  ref: string;
  /** "memory", "topic", or "entry" — mirrors `HybridSearchHit.scope`. */
  scope: string;
  text: string;
}

/**
 * Builds the volatile context block: topic NAMES only (never their
 * content), the hints that passed the relevance threshold (each tagged
 * with its ref), and the current date/time. This is what keeps
 * acceptance criterion 4 true — nothing else about the owner is in here
 * by default.
 */
export function buildContextBlock(params: {
  topicNames: string[];
  hints: PromptContextHint[];
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const nowFormatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(now);

  const lines: string[] = [];
  lines.push(`Current date/time (${TIMEZONE}): ${nowFormatted}`);
  lines.push("");
  lines.push(
    params.topicNames.length > 0
      ? `Topics you know about: ${params.topicNames.join(", ")}`
      : "Topics you know about: (none yet)",
  );
  lines.push("");

  if (params.hints.length === 0) {
    lines.push("Hints: (nothing relevant found for this message)");
  } else {
    lines.push("Hints (only use these if relevant to the owner's message):");
    for (const hint of params.hints) {
      lines.push(`${hint.ref} [${hint.scope}] ${hint.text}`);
    }
  }

  return lines.join("\n");
}

/** Converts `findHints`'s output into `PromptContextHint`s, assigning a ref to each hit that has a `sourceEntryId` (memories and entries; topic hits are listed by name in the topics line instead, so they get no ref). */
export function hintsToContext(
  hits: HybridSearchHit[],
  tracker: RefTracker,
  textByHit: (hit: HybridSearchHit) => string,
): PromptContextHint[] {
  const context: PromptContextHint[] = [];
  for (const hit of hits) {
    if (!hit.sourceEntryId) continue;
    const ref = tracker.assign(hit.sourceEntryId);
    context.push({ ref, scope: hit.scope, text: textByHit(hit) });
  }
  return context;
}
