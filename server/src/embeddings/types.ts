/**
 * Provider-independent embedding domain types. The Voyage adapter
 * (`embeddings/voyage.ts`) implements this port; callers (the embed
 * jobs, and T06's hybrid search) depend only on this interface, never on
 * Voyage's own request/response shape.
 */

/**
 * Voyage asks callers to say whether a text is a search query or a
 * document being indexed, and prepends a different internal prompt for
 * each — using the wrong one measurably hurts retrieval quality. Entries,
 * memories and topics are embedded as `"document"`; a search query is
 * embedded as `"query"`.
 */
export type EmbeddingInputType = "document" | "query";

export interface Embedder {
  /**
   * Embeds `texts` in order, returning one vector per input at the same
   * index. Returns `[]` for an empty `texts` array without making a
   * network call.
   */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}
