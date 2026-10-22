/**
 * Tracks the `#n` reference numbers assigned to source entries within
 * one agent turn — hints get refs before the model ever sees them,
 * `search` tool results extend the same numbering, and the final
 * citation mapping (`[#n]` in the assistant's text -> entry id) reads
 * back from the same tracker. One `RefTracker` instance per turn, never
 * shared across turns — refs are not stable across turns by design,
 * since the set of available context changes every turn.
 */
export class RefTracker {
  private readonly refToEntryId = new Map<string, string>();
  private readonly entryIdToRef = new Map<string, string>();
  private nextIndex = 1;

  /** Returns this entry's existing ref if already assigned this turn, or assigns and returns a new one. */
  assign(sourceEntryId: string): string {
    const existing = this.entryIdToRef.get(sourceEntryId);
    if (existing) {
      return existing;
    }
    const ref = `#${this.nextIndex}`;
    this.nextIndex += 1;
    this.refToEntryId.set(ref, sourceEntryId);
    this.entryIdToRef.set(sourceEntryId, ref);
    return ref;
  }

  /** The source entry id a ref points at, or `undefined` for an unknown/never-assigned ref. */
  resolve(ref: string): string | undefined {
    return this.refToEntryId.get(ref);
  }

  /** Every ref assigned so far, oldest first. */
  entries(): Array<{ ref: string; sourceEntryId: string }> {
    return [...this.refToEntryId.entries()].map(([ref, sourceEntryId]) => ({ ref, sourceEntryId }));
  }
}

const CITATION_PATTERN = /\[(#\d+)\]/g;

/** Extracts every `[#n]` citation in `text` and maps it to its source entry id via `tracker`. Refs with no known entry (a typo'd or hallucinated ref) are skipped, not thrown. */
export function extractCitations(
  text: string,
  tracker: RefTracker,
): Array<{ ref: string; sourceEntryId: string }> {
  const citations: Array<{ ref: string; sourceEntryId: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const ref = match[1];
    if (!ref || seen.has(ref)) continue;
    const sourceEntryId = tracker.resolve(ref);
    if (sourceEntryId) {
      citations.push({ ref, sourceEntryId });
      seen.add(ref);
    }
  }

  return citations;
}
